import { describe, expect, it } from "vitest";
import { resolveMqttHooksPluginConfig } from "./config.js";

describe("resolveMqttHooksPluginConfig", () => {
  it("applies defaults and normalizes subscription names", () => {
    const config = resolveMqttHooksPluginConfig({
      broker: { url: "mqtt://broker.local:1883" },
      subscriptions: [
        {
          id: "alerts",
          topic: "home/alerts/#",
          action: "agent",
        },
      ],
    });

    expect(config.runtime.maxPayloadBytes).toBe(256 * 1024);
    expect(config.runtime.maxConcurrentMessages).toBe(4);
    expect(config.runtime.dedupeWindowMs).toBe(30_000);
    expect(config.subscriptions[0]?.name).toBe("MQTT alerts");
    expect(config.subscriptions[0]?.messageTemplate).toContain("Source: MQTT");
  });

  it("rejects duplicate subscription ids", () => {
    expect(() =>
      resolveMqttHooksPluginConfig({
        broker: { url: "mqtt://broker.local:1883" },
        subscriptions: [
          { id: "dup", topic: "a/#", action: "wake" },
          { id: "dup", topic: "b/#", action: "wake" },
        ],
      }),
    ).toThrow(/duplicate subscription id/u);
  });

  it("rejects agent subscriptions using textTemplate", () => {
    expect(() =>
      resolveMqttHooksPluginConfig({
        broker: { url: "mqtt://broker.local:1883" },
        subscriptions: [
          {
            id: "bad",
            topic: "home/alerts/#",
            action: "agent",
            textTemplate: "wrong",
          },
        ],
      }),
    ).toThrow(/textTemplate/u);
  });

  it("rejects wake subscriptions using messageTemplate", () => {
    expect(() =>
      resolveMqttHooksPluginConfig({
        broker: { url: "mqtt://broker.local:1883" },
        subscriptions: [
          {
            id: "bad",
            topic: "home/events/#",
            action: "wake",
            messageTemplate: "wrong",
          },
        ],
      }),
    ).toThrow(/messageTemplate/u);
  });
});
