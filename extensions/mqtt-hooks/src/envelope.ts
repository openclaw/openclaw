import { TextDecoder } from "node:util";
import type { MqttMessageEnvelope, MqttMessagePacket, MqttSubscriptionConfig } from "./types.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function assertMqttPayloadSize(params: {
  subscriptionId: string;
  payloadSize: number;
  maxPayloadBytes: number;
}): void {
  if (params.payloadSize <= params.maxPayloadBytes) {
    return;
  }
  throw new Error(
    `payload too large for subscription ${params.subscriptionId}: ${params.payloadSize} bytes exceeds ${params.maxPayloadBytes}`,
  );
}

export function buildMqttMessageEnvelope(params: {
  subscription: MqttSubscriptionConfig;
  packet: MqttMessagePacket;
  receivedAt?: Date;
  maxPayloadBytes: number;
}): MqttMessageEnvelope {
  const payloadSize = params.packet.payload.byteLength;
  assertMqttPayloadSize({
    subscriptionId: params.subscription.id,
    payloadSize,
    maxPayloadBytes: params.maxPayloadBytes,
  });

  const envelope: MqttMessageEnvelope = {
    subscriptionId: params.subscription.id,
    topic: params.packet.topic,
    qos: params.packet.qos,
    retain: params.packet.retain,
    duplicate: params.packet.duplicate,
    receivedAt: (params.receivedAt ?? new Date()).toISOString(),
    payloadSize,
    semantic: params.subscription.semantic,
  };

  if (payloadSize === 0) {
    envelope.payloadText = "";
    return envelope;
  }

  try {
    const payloadText = utf8Decoder.decode(params.packet.payload);
    envelope.payloadText = payloadText;
    const trimmed = payloadText.trim();
    if (trimmed) {
      try {
        envelope.payloadJson = JSON.parse(trimmed) as unknown;
      } catch {
        // Keep plain text when JSON parsing is not applicable.
      }
    }
    return envelope;
  } catch {
    envelope.payloadBase64 = params.packet.payload.toString("base64");
    return envelope;
  }
}
