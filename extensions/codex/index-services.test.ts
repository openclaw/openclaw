import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function registerServices(pluginConfig: Record<string, unknown>) {
  const registerService = vi.fn();
  const config: OpenClawConfig = {
    agents: { entries: { main: {} } },
    plugins: { entries: { codex: { enabled: true, config: pluginConfig } } },
  };
  plugin.register(
    createTestPluginApi({
      id: "codex",
      config,
      pluginConfig,
      runtime: createPluginRuntimeMock({ config: { current: () => config } }),
      registerService,
    }),
  );
  return registerService.mock.calls.map(([service]) => service);
}

function registeredService(id: string, stoppable = true) {
  return expect.objectContaining({
    id,
    start: expect.any(Function),
    ...(stoppable ? { stop: expect.any(Function) } : {}),
  });
}

describe("Codex plugin services", () => {
  it("proactively monitors an explicitly configured remote websocket app-server", () => {
    const services = registerServices({
      appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
    });

    expect(services).toEqual(
      expect.arrayContaining([
        registeredService("codex-session-catalog"),
        registeredService("codex-app-server-process-reaper", false),
        registeredService("codex-app-server-connection-health"),
      ]),
    );
  });

  it("does not start remote connection monitoring for local Codex transports", () => {
    for (const appServer of [undefined, { transport: "stdio" }, { transport: "unix" }]) {
      const services = registerServices(appServer ? { appServer } : {});

      expect(services.map((service) => service.id)).not.toContain(
        "codex-app-server-connection-health",
      );
      expect(services).toEqual(
        expect.arrayContaining([
          registeredService("codex-session-catalog"),
          registeredService("codex-desktop-generation"),
          registeredService("codex-app-server-process-reaper", false),
        ]),
      );
    }
  });
});
