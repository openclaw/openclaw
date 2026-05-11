import { describe, expect, it, vi } from "vitest";
import { registerHomeAssistantPlugin } from "./register.runtime.js";

type Service = {
  id: string;
  start: (ctx: unknown) => unknown;
  stop?: (ctx: unknown) => unknown;
};

type RegisteredMethod = {
  method: string;
  handler: (args: unknown) => unknown;
  scope?: string;
};

function createFakeApi(pluginConfig: unknown) {
  const services: Service[] = [];
  const methods: RegisteredMethod[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const api = {
    pluginConfig,
    config: { plugins: { entries: { "home-assistant": { config: pluginConfig } } } },
    logger,
    registerService: (service: Service) => {
      services.push(service);
    },
    registerGatewayMethod: (
      method: string,
      handler: (args: unknown) => unknown,
      opts?: { scope?: string },
    ) => {
      methods.push({ method, handler, scope: opts?.scope });
    },
  };

  return { api, services, methods, logger };
}

describe("registerHomeAssistantPlugin", () => {
  describe("missing or invalid config", () => {
    it("registers a no-op service that logs the validation issues on start", () => {
      const { api, services, methods, logger } = createFakeApi({
        // missing tokenRef
        homeAssistantUrl: "ws://192.168.2.41:8123/api/websocket",
      });

      registerHomeAssistantPlugin(api as never);

      // Only the disabled-until-configured service registered, no gateway methods.
      expect(services).toHaveLength(1);
      expect(services[0].id).toBe("home-assistant");
      expect(methods).toHaveLength(0);

      services[0].start({});
      expect(logger.warn).toHaveBeenCalled();
      const message = logger.warn.mock.calls[0][0] as string;
      expect(message).toMatch(/disabled until configured/);
      expect(message).toMatch(/tokenRef/);
    });

    it("logs and skips when pluginConfig is undefined entirely", () => {
      const { api, services, methods, logger } = createFakeApi(undefined);

      registerHomeAssistantPlugin(api as never);

      expect(services).toHaveLength(1);
      expect(methods).toHaveLength(0);
      services[0].start({});
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("valid config", () => {
    const validConfig = {
      homeAssistantUrl: "ws://192.168.2.41:8123/api/websocket",
      tokenRef: "homeAssistant.jarvisKiosk",
      allowList: ["switch.gate_main"],
      denyServiceList: ["lock.unlock"],
      slots: { "tile.gate_main": "switch.gate_main" },
    };

    it("registers both gateway methods and the lifecycle service", () => {
      const { api, services, methods } = createFakeApi(validConfig);

      registerHomeAssistantPlugin(api as never);

      // home-assistant.subscribe + home-assistant.serviceCall.
      expect(methods.map((m) => m.method).sort()).toEqual([
        "home-assistant.serviceCall",
        "home-assistant.subscribe",
      ]);
      expect(methods.find((m) => m.method === "home-assistant.subscribe")?.scope).toBe(
        "operator.read",
      );
      expect(methods.find((m) => m.method === "home-assistant.serviceCall")?.scope).toBe(
        "operator.write",
      );

      expect(services).toHaveLength(1);
      expect(services[0].id).toBe("home-assistant");
      expect(typeof services[0].start).toBe("function");
      expect(typeof services[0].stop).toBe("function");
    });

    it("service-call handler throws a clear error when WS client is not yet started", async () => {
      const { api, methods } = createFakeApi(validConfig);
      registerHomeAssistantPlugin(api as never);

      const serviceCallMethod = methods.find((m) => m.method === "home-assistant.serviceCall");
      expect(serviceCallMethod).toBeTruthy();

      const responses: Array<{
        ok: boolean;
        payload?: unknown;
        error?: { code: string; message: string };
      }> = [];
      await serviceCallMethod!.handler({
        params: { domain: "switch", service: "toggle", target: "switch.gate_main" },
        respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => {
          responses.push({ ok, payload, error });
        },
        context: { broadcast: () => undefined },
      });

      expect(responses).toHaveLength(1);
      expect(responses[0].ok).toBe(false);
      expect(responses[0].error?.code).toBe("ha_call_failed");
      expect(responses[0].error?.message).toMatch(/not yet started/);
    });
  });
});
