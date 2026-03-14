import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMqttHooksPluginConfig } from "./config.js";
import { createMqttHooksService } from "./service.js";

class FakeMqttClient extends EventEmitter {
  subscribed: Array<{ topic: string; qos: number }> = [];
  subscribeErrors: Array<Error | null> = [];
  closed = false;

  subscribe(topic: string, options: { qos: 0 | 1 | 2 }, callback: (err?: Error | null) => void) {
    this.subscribed.push({ topic, qos: options.qos });
    callback(this.subscribeErrors.shift() ?? null);
  }

  end(_force: boolean, callback: (err?: Error | null) => void) {
    this.closed = true;
    callback(null);
  }

  removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }
}

class DelayedSubscribeMqttClient extends FakeMqttClient {
  subscribeCallbacks: Array<(err?: Error | null) => void> = [];

  override subscribe(
    topic: string,
    options: { qos: 0 | 1 | 2 },
    callback: (err?: Error | null) => void,
  ) {
    this.subscribed.push({ topic, qos: options.qos });
    this.subscribeCallbacks.push(callback);
  }

  resolveNextSubscribe(err: Error | null = null) {
    const callback = this.subscribeCallbacks.shift();
    if (!callback) {
      throw new Error("no pending subscribe callback");
    }
    callback(err);
  }
}

const sharedMocks = vi.hoisted(() => ({
  dispatchWakeIngressAction: vi.fn(),
  dispatchAgentIngressAction: vi.fn(() => "run-1"),
  resolveHookIngressPolicies: vi.fn(() => ({
    agentPolicy: {
      defaultAgentId: "main",
      knownAgentIds: new Set(["main", "hooks"]),
      allowedAgentIds: new Set(["hooks"]),
    },
    sessionPolicy: {
      defaultSessionKey: "hook:mqtt",
      allowRequestSessionKey: false,
      allowedSessionKeyPrefixes: ["hook:"],
    },
  })),
}));

vi.mock("openclaw/plugin-sdk/mqtt-hooks", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/mqtt-hooks")>(
    "openclaw/plugin-sdk/mqtt-hooks",
  );
  return {
    ...actual,
    dispatchWakeIngressAction: sharedMocks.dispatchWakeIngressAction,
    dispatchAgentIngressAction: sharedMocks.dispatchAgentIngressAction,
    resolveHookIngressPolicies: sharedMocks.resolveHookIngressPolicies,
  };
});

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("createMqttHooksService", () => {
  beforeEach(() => {
    sharedMocks.dispatchWakeIngressAction.mockClear();
    sharedMocks.dispatchAgentIngressAction.mockClear();
    sharedMocks.resolveHookIngressPolicies.mockClear();
  });

  it("subscribes on connect and dispatches agent messages", async () => {
    const fakeClient = new FakeMqttClient();
    const service = createMqttHooksService({
      pluginConfig: resolveMqttHooksPluginConfig({
        broker: { url: "mqtt://broker.local:1883" },
        subscriptions: [
          {
            id: "alerts",
            topic: "home/alerts/#",
            qos: 1,
            action: "agent",
            agentId: "hooks",
          },
        ],
      }),
      clientFactory: () => fakeClient as never,
      now: () => new Date("2026-03-10T12:00:00.000Z").getTime(),
      payloadHasher: () => "hash-1",
    });

    const logger = createLogger();
    await service.start({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger,
    });

    fakeClient.emit("connect");
    await vi.waitFor(() => {
      expect(fakeClient.subscribed).toEqual([{ topic: "home/alerts/#", qos: 1 }]);
    });

    fakeClient.emit("message", "home/alerts/kitchen", Buffer.from('{"message":"smoke"}'), {
      qos: 1,
      retain: false,
      dup: false,
    });

    await vi.waitFor(() => {
      expect(sharedMocks.dispatchAgentIngressAction).toHaveBeenCalledOnce();
    });

    await service.stop?.({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger,
    });
  });

  it("ignores retained messages during startup when configured", async () => {
    const fakeClient = new FakeMqttClient();
    const service = createMqttHooksService({
      pluginConfig: resolveMqttHooksPluginConfig({
        broker: { url: "mqtt://broker.local:1883" },
        subscriptions: [
          {
            id: "alerts",
            topic: "home/alerts/#",
            qos: 1,
            action: "wake",
            textTemplate: "Payload={{payloadText}}",
          },
        ],
      }),
      clientFactory: () => fakeClient as never,
      now: () => new Date("2026-03-10T12:00:00.000Z").getTime(),
      payloadHasher: () => "hash-1",
    });

    await service.start({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger: createLogger(),
    });

    fakeClient.emit("connect");
    fakeClient.emit("message", "home/alerts/kitchen", Buffer.from("retained"), {
      qos: 1,
      retain: true,
      dup: false,
    });

    await vi.waitFor(() => {
      expect(fakeClient.subscribed.length).toBe(1);
    });
    expect(sharedMocks.dispatchWakeIngressAction).not.toHaveBeenCalled();

    await service.stop?.({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger: createLogger(),
    });
  });

  it("deduplicates repeated messages inside the configured window", async () => {
    const fakeClient = new FakeMqttClient();
    const service = createMqttHooksService({
      pluginConfig: resolveMqttHooksPluginConfig({
        broker: { url: "mqtt://broker.local:1883" },
        subscriptions: [
          {
            id: "alerts",
            topic: "home/alerts/#",
            qos: 1,
            action: "wake",
            textTemplate: "Payload={{payloadText}}",
            ignoreRetainedOnStartup: false,
          },
        ],
      }),
      clientFactory: () => fakeClient as never,
      now: () => new Date("2026-03-10T12:00:00.000Z").getTime(),
      payloadHasher: () => "same-hash",
    });

    await service.start({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger: createLogger(),
    });

    fakeClient.emit("connect");
    const packet = { qos: 1, retain: false, dup: false };
    fakeClient.emit("message", "home/alerts/kitchen", Buffer.from("same"), packet);
    fakeClient.emit("message", "home/alerts/kitchen", Buffer.from("same"), packet);

    await vi.waitFor(() => {
      expect(sharedMocks.dispatchWakeIngressAction).toHaveBeenCalledOnce();
    });

    await service.stop?.({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger: createLogger(),
    });
  });

  it("drops oversized payloads before computing dedupe hashes", async () => {
    const fakeClient = new FakeMqttClient();
    const logger = createLogger();
    const payloadHasher = vi.fn(() => "oversized-hash");
    const service = createMqttHooksService({
      pluginConfig: resolveMqttHooksPluginConfig({
        broker: { url: "mqtt://broker.local:1883" },
        runtime: {
          maxPayloadBytes: 4,
        },
        subscriptions: [
          {
            id: "alerts",
            topic: "home/alerts/#",
            qos: 1,
            action: "wake",
            ignoreRetainedOnStartup: false,
          },
        ],
      }),
      clientFactory: () => fakeClient as never,
      payloadHasher,
    });

    await service.start({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger,
    });

    fakeClient.emit("connect");
    fakeClient.emit("message", "home/alerts/kitchen", Buffer.from("oversized"), {
      qos: 1,
      retain: false,
      dup: false,
    });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("payload too large"));
    });
    expect(payloadHasher).not.toHaveBeenCalled();
    expect(sharedMocks.dispatchWakeIngressAction).not.toHaveBeenCalled();

    await service.stop?.({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger,
    });
  });

  it("stops idempotently and closes the mqtt client", async () => {
    const fakeClient = new FakeMqttClient();
    const service = createMqttHooksService({
      pluginConfig: resolveMqttHooksPluginConfig({
        broker: { url: "mqtt://broker.local:1883" },
        subscriptions: [
          {
            id: "alerts",
            topic: "home/alerts/#",
            qos: 1,
            action: "wake",
          },
        ],
      }),
      clientFactory: () => fakeClient as never,
    });

    await service.start({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger: createLogger(),
    });

    await service.stop?.({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger: createLogger(),
    });
    await service.stop?.({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger: createLogger(),
    });

    expect(fakeClient.closed).toBe(true);
  });

  it("logs reconnect attempts as warnings", async () => {
    const fakeClient = new FakeMqttClient();
    const logger = createLogger();
    const service = createMqttHooksService({
      pluginConfig: resolveMqttHooksPluginConfig({
        broker: { url: "mqtt://broker.local:1883" },
        subscriptions: [
          {
            id: "alerts",
            topic: "home/alerts/#",
            qos: 1,
            action: "wake",
          },
        ],
      }),
      clientFactory: () => fakeClient as never,
    });

    await service.start({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger,
    });

    fakeClient.emit("reconnect");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("mqtt-hooks: reconnecting to"),
    );

    await service.stop?.({
      config: {},
      stateDir: "/tmp/openclaw-state",
      logger,
    });
  });

  it("re-arms startup retained guard when first subscribe attempt fails", async () => {
    vi.useFakeTimers();
    try {
      const fakeClient = new FakeMqttClient();
      fakeClient.subscribeErrors = [new Error("subscribe failed once"), null];

      const service = createMqttHooksService({
        pluginConfig: resolveMqttHooksPluginConfig({
          broker: { url: "mqtt://broker.local:1883" },
          subscriptions: [
            {
              id: "alerts",
              topic: "home/alerts/#",
              qos: 1,
              action: "wake",
              textTemplate: "Payload={{payloadText}}",
            },
          ],
        }),
        clientFactory: () => fakeClient as never,
      });

      await service.start({
        config: {},
        stateDir: "/tmp/openclaw-state",
        logger: createLogger(),
      });

      fakeClient.emit("connect");
      await Promise.resolve();

      fakeClient.emit("message", "home/alerts/kitchen", Buffer.from("retained-a"), {
        qos: 1,
        retain: true,
        dup: false,
      });
      await Promise.resolve();
      expect(sharedMocks.dispatchWakeIngressAction).not.toHaveBeenCalled();

      fakeClient.emit("connect");
      await Promise.resolve();

      fakeClient.emit("message", "home/alerts/kitchen", Buffer.from("retained-b"), {
        qos: 1,
        retain: true,
        dup: false,
      });
      await Promise.resolve();
      expect(sharedMocks.dispatchWakeIngressAction).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1600);

      fakeClient.emit("message", "home/alerts/kitchen", Buffer.from("retained-c"), {
        qos: 1,
        retain: true,
        dup: false,
      });
      await vi.waitFor(() => {
        expect(sharedMocks.dispatchWakeIngressAction).toHaveBeenCalledOnce();
      });

      await service.stop?.({
        config: {},
        stateDir: "/tmp/openclaw-state",
        logger: createLogger(),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stopped run arm the next startup retained guard timer", async () => {
    vi.useFakeTimers();
    try {
      const firstClient = new DelayedSubscribeMqttClient();
      const secondClient = new FakeMqttClient();
      const clients = [firstClient, secondClient];
      const service = createMqttHooksService({
        pluginConfig: resolveMqttHooksPluginConfig({
          broker: { url: "mqtt://broker.local:1883" },
          subscriptions: [
            {
              id: "alerts",
              topic: "home/alerts/#",
              qos: 1,
              action: "wake",
              textTemplate: "Payload={{payloadText}}",
            },
          ],
        }),
        clientFactory: () => {
          const nextClient = clients.shift();
          if (!nextClient) {
            throw new Error("no mqtt client left for test");
          }
          return nextClient as never;
        },
      });

      await service.start({
        config: {},
        stateDir: "/tmp/openclaw-state",
        logger: createLogger(),
      });

      firstClient.emit("connect");
      await Promise.resolve();

      await service.stop?.({
        config: {},
        stateDir: "/tmp/openclaw-state",
        logger: createLogger(),
      });

      firstClient.resolveNextSubscribe();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);

      await service.start({
        config: {},
        stateDir: "/tmp/openclaw-state",
        logger: createLogger(),
      });

      secondClient.emit("connect");
      await vi.waitFor(() => {
        expect(secondClient.subscribed).toEqual([{ topic: "home/alerts/#", qos: 1 }]);
      });

      secondClient.emit("message", "home/alerts/kitchen", Buffer.from("retained-early"), {
        qos: 1,
        retain: true,
        dup: false,
      });
      await Promise.resolve();
      expect(sharedMocks.dispatchWakeIngressAction).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      secondClient.emit("message", "home/alerts/kitchen", Buffer.from("retained-still-blocked"), {
        qos: 1,
        retain: true,
        dup: false,
      });
      await Promise.resolve();
      expect(sharedMocks.dispatchWakeIngressAction).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      secondClient.emit("message", "home/alerts/kitchen", Buffer.from("retained-allowed"), {
        qos: 1,
        retain: true,
        dup: false,
      });
      await vi.waitFor(() => {
        expect(sharedMocks.dispatchWakeIngressAction).toHaveBeenCalledOnce();
      });

      await service.stop?.({
        config: {},
        stateDir: "/tmp/openclaw-state",
        logger: createLogger(),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
