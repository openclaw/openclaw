import { describe, expect, it } from "vitest";
import { buildMqttMessageEnvelope } from "./envelope.js";
import type { MqttSubscriptionConfig } from "./types.js";

const baseSubscription: MqttSubscriptionConfig = {
  id: "alerts",
  enabled: true,
  topic: "home/alerts/#",
  qos: 1,
  ignoreRetainedOnStartup: true,
  action: "agent",
  name: "MQTT alerts",
  wakeMode: "now",
  messageTemplate: "Payload: {{payloadText}}",
};

describe("buildMqttMessageEnvelope", () => {
  it("keeps utf-8 text payloads", () => {
    const envelope = buildMqttMessageEnvelope({
      subscription: baseSubscription,
      packet: {
        topic: "home/alerts/kitchen",
        payload: Buffer.from("temperature high", "utf8"),
        qos: 1,
        retain: false,
        duplicate: false,
      },
      maxPayloadBytes: 1024,
      receivedAt: new Date("2026-03-10T12:00:00.000Z"),
    });

    expect(envelope.payloadText).toBe("temperature high");
    expect(envelope.payloadJson).toBeUndefined();
    expect(envelope.receivedAt).toBe("2026-03-10T12:00:00.000Z");
  });

  it("parses json payloads when possible", () => {
    const envelope = buildMqttMessageEnvelope({
      subscription: baseSubscription,
      packet: {
        topic: "home/alerts/kitchen",
        payload: Buffer.from('{"level":"critical","value":42}', "utf8"),
        qos: 1,
        retain: false,
        duplicate: false,
      },
      maxPayloadBytes: 1024,
    });

    expect(envelope.payloadJson).toEqual({ level: "critical", value: 42 });
  });

  it("falls back to base64 for non-utf8 payloads", () => {
    const envelope = buildMqttMessageEnvelope({
      subscription: baseSubscription,
      packet: {
        topic: "home/raw",
        payload: Buffer.from([0xff, 0xfe, 0xfd]),
        qos: 0,
        retain: false,
        duplicate: false,
      },
      maxPayloadBytes: 1024,
    });

    expect(envelope.payloadText).toBeUndefined();
    expect(envelope.payloadBase64).toBe("//79");
  });

  it("rejects oversized payloads", () => {
    expect(() =>
      buildMqttMessageEnvelope({
        subscription: baseSubscription,
        packet: {
          topic: "home/raw",
          payload: Buffer.alloc(8),
          qos: 0,
          retain: false,
          duplicate: false,
        },
        maxPayloadBytes: 4,
      }),
    ).toThrow(/payload too large/u);
  });
});
