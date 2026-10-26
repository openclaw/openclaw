import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
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

describe("onepassword plugin", () => {
  it("opens bounded grant, audit, and pending stores", () => {
    const { openKeyedStore, openKeyedStoreV2, registerCli, registerTool } = register();
    expect(openKeyedStoreV2).toHaveBeenCalledWith({
      namespace: "grants",
      maxEntries: 1_024,
      overflowPolicy: "evict-oldest",
    });
    for (const [index, [namespace, maxEntries]] of [
      ["audit", 40_000],
      ["pending", 512],
    ].entries()) {
      expect(openKeyedStore).toHaveBeenNthCalledWith(index + 1, {
        namespace,
        maxEntries,
        overflowPolicy: "evict-oldest",
      });
    }
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("evaluates enablement and before-tool policy from live plugin config", async () => {
    const pluginConfig = (policy: "auto" | "deny") => ({
      vault: "Automation",
      items: { deploy: { item: "Deploy token", field: "credential", policy } },
    });
    let livePolicy: "auto" | "deny" = "auto";
    let liveEnabled = true;
    const current = () => ({
      plugins: {
        entries: {
          onepassword: {
            enabled: liveEnabled,
            config: pluginConfig(livePolicy),
          },
        },
      },
    });
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

    liveEnabled = false;
    await expect(evaluate("live-enabled-1", "test live enablement")).resolves.toMatchObject({
      block: true,
    });

    liveEnabled = true;
    livePolicy = "deny";
    await expect(evaluate("live-policy-1", "test live policy")).resolves.toMatchObject({
      block: true,
    });
  });
});
