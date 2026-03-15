import type { OpenClawPluginApi } from "openclaw/plugin-sdk/mqtt-hooks";
import { describe, expect, it, vi } from "vitest";

const createServiceMock = vi.hoisted(() =>
  vi.fn((_params: unknown) => ({
    id: "mqtt-hooks",
    start: vi.fn(),
  })),
);

vi.mock("./src/service.js", () => ({
  createMqttHooksService: createServiceMock,
}));

import mqttHooksPlugin from "./index.js";

describe("mqtt-hooks plugin register", () => {
  it("normalizes plugin config before creating service", () => {
    const registerService = vi.fn();

    mqttHooksPlugin.register({
      pluginConfig: {
        broker: { url: "mqtt://broker.local:1883" },
        subscriptions: [
          {
            id: "alerts",
            topic: "home/alerts/#",
            action: "wake",
          },
        ],
      },
      registerService,
    } as unknown as OpenClawPluginApi);

    expect(createServiceMock).toHaveBeenCalledOnce();
    const serviceParams = createServiceMock.mock.calls.at(0)?.[0] as
      | { pluginConfig: { runtime: { maxConcurrentMessages: number; maxPayloadBytes: number } } }
      | undefined;
    expect(serviceParams?.pluginConfig.runtime.maxConcurrentMessages).toBe(4);
    expect(serviceParams?.pluginConfig.runtime.maxPayloadBytes).toBe(256 * 1024);
    const subscriptions = (
      serviceParams?.pluginConfig as { subscriptions?: Array<{ enabled?: boolean }> } | undefined
    )?.subscriptions;
    expect(subscriptions?.[0]?.enabled).toBe(true);
    expect(registerService).toHaveBeenCalledOnce();
  });
});
