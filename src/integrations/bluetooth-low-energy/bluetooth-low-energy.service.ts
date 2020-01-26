import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleInit
} from '@nestjs/common';
import noble, { Peripheral } from '@abandonware/noble';
import * as _ from 'lodash';
import slugify from 'slugify';
import { EntitiesService } from '../../entities/entities.service';
import { Sensor } from '../../entities/sensor.entity';
import { IBeacon } from './i-beacon';
import { Tag } from './tag';
import { ConfigService } from '../../config/config.service';
import { Entity } from '../../entities/entity.entity';
import { BluetoothLowEnergyConfig } from './bluetooth-low-energy.config';
import { ClusterService } from '../../cluster/cluster.service';
import { NewDistanceEvent } from './new-distance.event';
import { EntityCustomization } from '../../entities/entity-customization.interface';
import { SensorConfig } from '../home-assistant/sensor-config';
import { RoomPresenceDistanceSensor } from '../room-presence/room-presence-distance.sensor';
import { SchedulerRegistry } from '@nestjs/schedule';
import KalmanFilter from 'kalmanjs';

export const NEW_DISTANCE_CHANNEL = 'bluetooth-low-energy.new-distance';

@Injectable()
export class BluetoothLowEnergyService
  implements OnModuleInit, OnApplicationBootstrap {
  private readonly config: BluetoothLowEnergyConfig;
  private filterMap: Map<string, KalmanFilter> = new Map<
    string,
    KalmanFilter
  >();

  constructor(
    private readonly entitiesService: EntitiesService,
    private readonly configService: ConfigService,
    private readonly clusterService: ClusterService,
    private readonly schedulerRegistry: SchedulerRegistry
  ) {
    this.config = this.configService.get('bluetoothLowEnergy');
  }

  /**
   * Lifecycle hook, called once the host module has been initialized.
   */
  onModuleInit(): void {
    noble.on('stateChange', BluetoothLowEnergyService.handleStateChange);
    noble.on('discover', this.handleDiscovery.bind(this));
  }

  /**
   * Lifecycle hook, called once the application has started.
   */
  onApplicationBootstrap(): void {
    this.clusterService.on(
      NEW_DISTANCE_CHANNEL,
      this.handleNewDistance.bind(this)
    );
    this.clusterService.subscribe(NEW_DISTANCE_CHANNEL);
  }

  /**
   * Filters found BLE peripherals and publishes new distance data to sensors, depending on configuration.
   *
   * @param peripheral - BLE peripheral
   */
  handleDiscovery(peripheral: Peripheral): void {
    let tag = this.createTag(peripheral);
    if (this.config.onlyIBeacon && !(tag instanceof IBeacon)) {
      return;
    }

    if (this.isOnWhitelist(tag.id)) {
      tag = this.applyOverrides(tag);
      tag.rssi = this.filterRssi(tag.id, tag.rssi);

      const sensorId = slugify(`ble ${_.lowerCase(tag.id)}`);
      let sensor: Entity;
      if (this.entitiesService.has(sensorId)) {
        sensor = this.entitiesService.get(sensorId);
      } else {
        sensor = this.createDistanceSensor(sensorId, tag.name);
      }
      sensor.state = tag.distance;

      const globalSettings = this.configService.get('global');
      const event = new NewDistanceEvent(
        globalSettings.instanceName,
        tag.id,
        tag.name,
        tag.distance
      );
      this.handleNewDistance(event);
      this.clusterService.publish(NEW_DISTANCE_CHANNEL, event);
    }
  }

  /**
   * Passes newly found distance information to aggregated room presence sensors.
   *
   * @param event - Event with new distance data
   */
  handleNewDistance(event: NewDistanceEvent): void {
    const sensorId = slugify(_.lowerCase(`ble ${event.tagId} room presence`));
    let sensor: RoomPresenceDistanceSensor;
    if (this.entitiesService.has(sensorId)) {
      sensor = this.entitiesService.get(sensorId) as RoomPresenceDistanceSensor;
    } else {
      sensor = this.createRoomPresenceSensor(sensorId, event.tagName);
    }

    sensor.handleNewDistance(event.instanceName, event.distance);
  }

  /**
   * Determines if the manufacturer data of a BLE peripheral belongs to an iBeacon or not.
   *
   * @param manufacturerData - Buffer of BLE peripheral manufacturer data
   * @returns Whether the data belongs to an iBeacon or not
   */
  isIBeacon(manufacturerData: Buffer): boolean {
    return (
      manufacturerData &&
      25 <= manufacturerData.length && // expected data length
      0x004c === manufacturerData.readUInt16LE(0) && // apple company identifier
      0x02 === manufacturerData.readUInt8(2) && // ibeacon type
      0x15 === manufacturerData.readUInt8(3)
    ); // expected ibeacon data length
  }

  /**
   * Checks if an id is on the whitelist of this component.
   * Always returns true if the whitelist is empty.
   *
   * @param id - Device id
   * @return Whether the id is on the whitelist or not
   */
  isOnWhitelist(id: string): boolean {
    const whitelist = this.config.whitelist;
    if (whitelist === undefined || whitelist.length === 0) {
      return true;
    }

    return this.config.whitelistRegex
      ? whitelist.some(regex => id.match(regex))
      : whitelist.includes(id);
  }

  /**
   * Applies the Kalman filter based on the historic values with the same tag id.
   *
   * @param tagId - Tag id that matches the measured device
   * @param rssi - Measured signal strength
   * @returns Smoothed signal strength value
   */
  filterRssi(tagId: string, rssi: number): number {
    if (this.filterMap.has(tagId)) {
      return this.filterMap.get(tagId).filter(rssi);
    } else {
      // filter params taken from: https://www.researchgate.net/publication/316501991_An_Improved_BLE_Indoor_Localization_with_Kalman-Based_Fusion_An_Experimental_Study
      const kalman = new KalmanFilter({ R: 1.4, Q: 0.065 });
      this.filterMap.set(tagId, kalman);
      return kalman.filter(rssi);
    }
  }

  /**
   * Creates and registers a new distance sensor (this machine <> peripheral).
   *
   * @param sensorId - Id that the sensor should receive
   * @param deviceName - Name of the BLE peripheral
   * @returns Registered sensor
   */
  protected createDistanceSensor(sensorId: string, deviceName: string): Sensor {
    const globalSettings = this.configService.get('global');

    const sensorName = `Distance ${globalSettings.instanceName} - ${deviceName}`;
    const customizations: Array<EntityCustomization<any>> = [
      {
        for: SensorConfig,
        overrides: {
          icon: 'mdi:bluetooth',
          unitOfMeasurement: 'm'
        }
      }
    ];

    return this.entitiesService.add(
      new Sensor(sensorId, sensorName),
      customizations
    ) as Sensor;
  }

  /**
   * Creates and registers a new room presence sensor.
   *
   * @param sensorId - Id that the sensor should receive
   * @param deviceName - Name of the BLE peripheral
   * @returns Registered room presence sensor
   */
  protected createRoomPresenceSensor(
    sensorId: string,
    deviceName: string
  ): RoomPresenceDistanceSensor {
    const sensorName = `${deviceName} Room Presence`;
    const customizations: Array<EntityCustomization<any>> = [
      {
        for: SensorConfig,
        overrides: {
          icon: 'mdi:bluetooth'
        }
      }
    ];
    const sensor = this.entitiesService.add(
      new RoomPresenceDistanceSensor(sensorId, sensorName, this.config.timeout),
      customizations
    ) as RoomPresenceDistanceSensor;

    const interval = setInterval(
      sensor.checkForTimeout.bind(sensor),
      this.config.timeout * 1000
    );
    this.schedulerRegistry.addInterval(`${sensorId}_timeout_check`, interval);

    return sensor;
  }

  /**
   * Creates a tag based on a given BLE peripheral.
   *
   * @param peripheral - Noble BLE peripheral
   * @returns Tag or IBeacon
   */
  protected createTag(peripheral: Peripheral): Tag {
    if (
      this.config.processIBeacon &&
      this.isIBeacon(peripheral.advertisement.manufacturerData)
    ) {
      return new IBeacon(
        peripheral,
        this.config.majorMask,
        this.config.minorMask
      );
    } else {
      return new Tag(peripheral);
    }
  }

  /**
   * Checks if overrides have been configured for a tag and then applies them.
   *
   * @param tag - Tag that should be overridden
   * @returns Same tag with potentially overridden data
   */
  protected applyOverrides(tag: Tag): Tag {
    if (this.config.tagOverrides.hasOwnProperty(tag.id)) {
      const overrides = this.config.tagOverrides[tag.id];
      if (overrides.measuredPower !== undefined) {
        tag.measuredPower = overrides.measuredPower;
      }
    }

    return tag;
  }

  /**
   * Stops or starts BLE scans based on the adapter state.
   *
   * @param state - Noble adapter state string
   */
  private static handleStateChange(state: string): void {
    if (state === 'poweredOn') {
      noble.startScanning([], true);
    } else {
      noble.stopScanning();
    }
  }
}
