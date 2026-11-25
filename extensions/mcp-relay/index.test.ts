import type { GatewayControlUiIngressFactoryV2 } from "openclaw/plugin-sdk/gateway-ingress";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { assert, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { createStateFixture } from "./src/relay.test-helpers.js";

it.each(["ready", "rejected", "aborted"] as const)(
  "registered start retains principal recovery readiness: %s",
  async (outcome) => {
    const storage = createStateFixture();
    const registered = vi.fn<OpenClawPluginApi["registerService"]>();
    const api = createTestPluginApi({
      id: "mcp-relay",
      pluginConfig: {},
      registerCli: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerService: registered,
    });
    Object.assign(api.runtime, {
      state: storage.runtime.state,
      version: "test",
      config: { current: () => ({}) },
    });
    Object.assign(api.session.controls, { registerControlUiDescriptor: vi.fn() });
    plugin.register?.(api);
    const service = registered.mock.calls[0]?.[0];
    if (service?.apiVersion !== 2) {
      throw new Error("Expected service API version 2");
    }
    assert(service);
    const clock = createGatewaySchedulerClock(1_000);
    const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
    const schedule = vi.spyOn(scheduler, "schedule");
    const entered = Promise.withResolvers<void>();
    const registration = Promise.withResolvers<void>();
    const ingress: GatewayControlUiIngressFactoryV2 = {
      capabilityVersion: 2,
      bindPrincipal: async () => {
        throw new Error("Relay connection must not run before startup readiness");
      },
      open: async () => {
        throw new Error("UI presentation is not needed for registered service startup");
      },
      registerPrincipalRecovery: async () => {
        entered.resolve();
        await registration.promise;
      },
    };
    const context = {
      config: {},
      stateDir: "/isolated-mcp-start",
      logger: api.logger,
      scheduler,
      controlUiIngress: ingress,
    };
    const start = Promise.resolve(service.start(context));
    void start.catch(() => {});
    try {
      expect(
        await Promise.race([entered.promise.then(() => "registered"), start.then(() => "settled")]),
      ).toBe("registered");
      expect(schedule).not.toHaveBeenCalled();
      if (outcome === "rejected") {
        const failure = new Error("Recovery registration refused");
        registration.reject(failure);
        await expect(start).rejects.toBe(failure);
      } else {
        if (outcome === "aborted") {
          scheduler.beginClose();
        }
        registration.resolve();
        if (outcome === "aborted") {
          await expect(start).rejects.toThrow();
        } else {
          await start;
          expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ id: "connect" }));
        }
      }
      if (outcome !== "ready") {
        expect(schedule).not.toHaveBeenCalled();
      }
    } finally {
      registration.resolve();
      await start.catch(() => {});
      await service.stop?.(context);
      await scheduler.stop();
    }
  },
);
