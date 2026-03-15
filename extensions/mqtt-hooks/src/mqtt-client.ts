import { connect } from "mqtt";
import type { MqttBrokerConfig } from "./types.js";

export type MqttClientMessagePacket = {
  qos?: number;
  retain?: boolean;
  dup?: boolean;
};

export type MqttClientLike = {
  on(event: "connect", listener: () => void): MqttClientLike;
  on(event: "reconnect", listener: () => void): MqttClientLike;
  on(event: "close", listener: () => void): MqttClientLike;
  on(event: "offline", listener: () => void): MqttClientLike;
  on(event: "error", listener: (err: Error) => void): MqttClientLike;
  on(
    event: "message",
    listener: (topic: string, payload: Buffer, packet: MqttClientMessagePacket) => void,
  ): MqttClientLike;
  subscribe(
    topic: string,
    options: { qos: 0 | 1 | 2 },
    callback: (err?: Error | null) => void,
  ): void;
  end(force: boolean, callback: (err?: Error | null) => void): void;
  removeAllListeners(): MqttClientLike;
};

export type MqttClientFactory = (broker: MqttBrokerConfig) => MqttClientLike;

export function createDefaultMqttClientFactory(): MqttClientFactory {
  return (broker) =>
    connect(broker.url, {
      ...(broker.clientId ? { clientId: broker.clientId } : {}),
      ...(broker.username ? { username: broker.username } : {}),
      ...(broker.password ? { password: broker.password } : {}),
      ...(broker.keepaliveSeconds ? { keepalive: broker.keepaliveSeconds } : {}),
      ...(typeof broker.clean === "boolean" ? { clean: broker.clean } : {}),
      ...(broker.reconnectPeriodMs ? { reconnectPeriod: broker.reconnectPeriodMs } : {}),
      ...(broker.connectTimeoutMs ? { connectTimeout: broker.connectTimeoutMs } : {}),
    }) as unknown as MqttClientLike;
}

export async function subscribeTopic(
  client: MqttClientLike,
  topic: string,
  qos: 0 | 1 | 2,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.subscribe(topic, { qos }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function closeMqttClient(client: MqttClientLike): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.end(false, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
