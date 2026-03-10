import { TextDecoder } from "node:util";
import type { MqttMessageEnvelope, MqttMessagePacket, MqttSubscriptionConfig } from "./types.js";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function buildMqttMessageEnvelope(params: {
  subscription: MqttSubscriptionConfig;
  packet: MqttMessagePacket;
  receivedAt?: Date;
  maxPayloadBytes: number;
}): MqttMessageEnvelope {
  const payloadSize = params.packet.payload.byteLength;
  if (payloadSize > params.maxPayloadBytes) {
    throw new Error(
      `payload too large for subscription ${params.subscription.id}: ${payloadSize} bytes exceeds ${params.maxPayloadBytes}`,
    );
  }

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
