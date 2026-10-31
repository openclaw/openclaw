import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { OnePasswordBroker } from "./src/broker.js";
import { MemoryKeyedStore } from "./src/memory-store.test-support.js";

function register(
  current: () => OpenClawConfig = () => ({}),
  pluginConfig?: Record<string, unknown>,
) {
  const hooks = { registerCli: vi.fn(), registerTool: vi.fn(), on: vi.fn() };
  const openKeyedStore = vi.fn(() => new MemoryKeyedStore());
  const openKeyedStoreV2 = vi.fn(() => new MemoryKeyedStore());
  plugin.register(
    createTestPluginApi({
      id: "onepassword",
      pluginConfig,
      runtime: {
        config: { current },
        state: {
          openKeyedStore,
          openKeyedStoreV2,
          resolveStateDir: () => "/tmp/openclaw-onepassword-test",
        },
      } as never,
      ...hooks,
    }),
  );
  return { ...hooks, openKeyedStore, openKeyedStoreV2 };
}

it("opens bounded stores and registers only the CLI when unconfigured", () => {
  const { registerCli, registerTool, openKeyedStore, openKeyedStoreV2 } = register();
  expect(openKeyedStoreV2).toHaveBeenCalledWith({
    namespace: "grants",
    maxEntries: 1_024,
    overflowPolicy: "evict-oldest",
  });
  expect(openKeyedStore.mock.calls).toEqual([
    [{ namespace: "audit", maxEntries: 40_000, overflowPolicy: "evict-oldest" }],
    [{ namespace: "pending", maxEntries: 512, overflowPolicy: "evict-oldest" }],
  ]);
  expect(registerCli).toHaveBeenCalledTimes(1);
  expect(registerTool).not.toHaveBeenCalled();
});

it("evaluates enablement and before-tool policy from live plugin config", async () => {
  const pluginConfig = (policy: "auto" | "deny") => ({
    vault: "Automation",
    items: { deploy: { item: "Deploy token", field: "credential", policy } },
  });
  const entry = { enabled: true, config: pluginConfig("auto") };
  const current = () => ({ plugins: { entries: { onepassword: entry } } });
  const { on } = register(current, pluginConfig("auto"));
  const beforeToolCall = on.mock.calls.find(([name]) => name === "before_tool_call")?.[1] as
    | OnePasswordBroker["beforeToolCall"]
    | undefined;
  assert(beforeToolCall, "missing before_tool_call hook");
  const context = { toolName: "onepassword", toolCallId: "live-policy", agentId: "agent-a" };
  const evaluate = () =>
    beforeToolCall(
      { ...context, params: { action: "get", slug: "deploy", reason: "test live config" } },
      context,
    );

  entry.enabled = false;
  await expect(evaluate()).resolves.toMatchObject({ block: true });

  entry.enabled = true;
  entry.config = pluginConfig("deny");
  await expect(evaluate()).resolves.toMatchObject({ block: true });
});
