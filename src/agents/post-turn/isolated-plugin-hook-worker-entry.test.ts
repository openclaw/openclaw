import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookRegistration } from "../../plugins/hook-types.js";

vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: () => ({}),
}));

vi.mock("../../plugins/runtime/runtime-registry-loader.js", () => ({
  ensurePluginRegistryLoaded: vi.fn(),
}));

function createRegistry(hooks: PluginHookRegistration[]) {
  return {
    hooks: [],
    typedHooks: hooks,
    plugins: hooks.map((hook) => ({ id: hook.pluginId, status: "loaded" as const })),
  };
}

describe("isolated post-turn plugin hook worker", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
  });

  it("runs only the scheduled hook registration when a plugin has multiple handlers", async () => {
    const { runIsolatedPluginHookWorkerRequest } = await import(
      "./isolated-plugin-hook-worker-entry.js"
    );
    const firstHandler = vi.fn(async () => undefined);
    const secondHandler = vi.fn(async () => undefined);
    initializeGlobalHookRunner(
      createRegistry([
        {
          pluginId: "memory-plugin",
          hookName: "agent_end",
          handler: firstHandler,
          source: "test:first",
        },
        {
          pluginId: "memory-plugin",
          hookName: "agent_end",
          handler: secondHandler,
          source: "test:second",
        },
      ]),
    );

    await runIsolatedPluginHookWorkerRequest({
      hookName: "agent_end",
      pluginId: "memory-plugin",
      registrationOrdinal: 1,
      event: { messages: [], success: true, durationMs: 1 },
      ctx: { agentId: "main" },
    });

    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });
});
