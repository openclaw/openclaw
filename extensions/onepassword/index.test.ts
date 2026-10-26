import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { OnePasswordBroker } from "./src/broker.js";

function register(
  current: () => OpenClawConfig = () => ({}),
  pluginConfig?: Record<string, unknown>,
) {
  const store = {
    register: vi.fn(async () => undefined),
    lookup: vi.fn(async () => undefined),
    lookupMany: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
    entries: vi.fn(async () => []),
  };
  const hooks = { registerCli: vi.fn(), registerTool: vi.fn(), on: vi.fn() };
  const openKeyedStore = vi.fn(() => store);
  const openKeyedStoreV2 = vi.fn(() => store);
  plugin.register(
    createTestPluginApi({
      id: "onepassword",
      config: current(),
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
  return { openKeyedStore, openKeyedStoreV2, ...hooks };
}

it("opens bounded grant, audit, and pending stores", () => {
  const { openKeyedStore, openKeyedStoreV2, registerCli, registerTool } = register();
  const options = (namespace: string, maxEntries: number) => ({
    namespace,
    maxEntries,
    overflowPolicy: "evict-oldest",
  });
  expect(openKeyedStoreV2.mock.calls).toEqual([[options("grants", 1_024)]]);
  expect(openKeyedStore.mock.calls).toEqual([
    [options("audit", 40_000)],
    [options("pending", 512)],
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
  const evaluate = (toolCallId: string, reason: string) =>
    beforeToolCall(
      { toolName: "onepassword", toolCallId, params: { action: "get", slug: "deploy", reason } },
      { toolName: "onepassword", toolCallId, agentId: "agent-a" },
    );

  entry.enabled = false;
  await expect(evaluate("live-enabled-1", "test live enablement")).resolves.toMatchObject({
    block: true,
  });

  entry.enabled = true;
  entry.config = pluginConfig("deny");
  await expect(evaluate("live-policy-1", "test live policy")).resolves.toMatchObject({
    block: true,
  });
});
