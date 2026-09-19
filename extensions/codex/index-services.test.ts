import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function registerServices(pluginConfig: Record<string, unknown>) {
  const registerService = vi.fn();
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main" }] },
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
  return registerService;
}

describe("Codex plugin services", () => {
  it("proactively monitors an explicitly configured remote websocket app-server", () => {
    const registerService = registerServices({
      appServer: { transport: "websocket", url: "ws://127.0.0.1:39175" },
    });

    expect(registerService.mock.calls.map(([service]) => service)).toContainEqual(
      expect.objectContaining({
        id: "codex-session-catalog",
        start: expect.any(Function),
        stop: expect.any(Function),
      }),
    );
    expect(registerService.mock.calls.map(([service]) => service)).toContainEqual(
      expect.objectContaining({
        id: "codex-app-server-process-reaper",
        start: expect.any(Function),
      }),
    );
    expect(registerService.mock.calls.map(([service]) => service)).toContainEqual(
      expect.objectContaining({
        id: "codex-app-server-connection-health",
        start: expect.any(Function),
        stop: expect.any(Function),
      }),
    );
  });

  it("does not start remote connection monitoring for local Codex transports", () => {
    for (const appServer of [undefined, { transport: "stdio" }, { transport: "unix" }]) {
      const registerService = registerServices(appServer ? { appServer } : {});

      expect(registerService.mock.calls.map(([service]) => service)).toContainEqual(
        expect.objectContaining({
          id: "codex-session-catalog",
          start: expect.any(Function),
          stop: expect.any(Function),
        }),
      );
      expect(registerService.mock.calls.map(([service]) => service.id)).not.toContain(
        "codex-app-server-connection-health",
      );
      expect(registerService.mock.calls.map(([service]) => service)).toContainEqual(
        expect.objectContaining({
          id: "codex-desktop-generation",
          start: expect.any(Function),
          stop: expect.any(Function),
        }),
      );
      expect(registerService.mock.calls.map(([service]) => service)).toContainEqual(
        expect.objectContaining({
          id: "codex-app-server-process-reaper",
          start: expect.any(Function),
        }),
      );
    }
  });
});
