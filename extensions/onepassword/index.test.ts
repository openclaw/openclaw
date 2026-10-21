import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("onepassword plugin", () => {
  it("opens bounded grant, audit, and pending stores", () => {
    const store = {
      register: vi.fn(),
      lookup: vi.fn(),
      lookupMany: vi.fn(async () => []),
      delete: vi.fn(),
      entries: vi.fn(async () => []),
    };
    const openKeyedStore = vi.fn(() => store);
    const openKeyedStoreV2 = vi.fn(() => store);
    const registerCli = vi.fn();
    const registerTool = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "onepassword",
        name: "1Password",
        source: "test",
        config: {},
        runtime: {
          config: { current: () => ({}) },
          state: {
            openKeyedStore,
            openKeyedStoreV2,
            resolveStateDir: () => "/tmp/openclaw-onepassword-test",
          },
        } as never,
        registerCli,
        registerTool,
      }),
    );

    expect(openKeyedStoreV2).toHaveBeenCalledWith({
      namespace: "grants",
      maxEntries: 1_024,
      overflowPolicy: "evict-oldest",
    });
    expect(openKeyedStore).toHaveBeenNthCalledWith(1, {
      namespace: "audit",
      maxEntries: 40_000,
      overflowPolicy: "evict-oldest",
    });
    expect(openKeyedStore).toHaveBeenNthCalledWith(2, {
      namespace: "pending",
      maxEntries: 512,
      overflowPolicy: "evict-oldest",
    });
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("evaluates enablement and before-tool policy from live plugin config", async () => {
    const pluginConfig = (policy: "auto" | "deny") => ({
      vault: "Automation",
      items: {
        deploy: {
          item: "Deploy token",
          field: "credential",
          policy,
        },
      },
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
    const store = {
      register: vi.fn(async () => undefined),
      lookup: vi.fn(async () => undefined),
      lookupMany: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      entries: vi.fn(async () => []),
    };
    const on = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "onepassword",
        name: "1Password",
        source: "test",
        config: current(),
        pluginConfig: pluginConfig("auto"),
        runtime: {
          config: { current },
          state: {
            openKeyedStore: () => store,
            openKeyedStoreV2: () => store,
            resolveStateDir: () => "/tmp/openclaw-onepassword-test",
          },
        } as never,
        registerCli: vi.fn(),
        registerTool: vi.fn(),
        on,
      }),
    );

    const beforeToolCall = on.mock.calls.find(([name]) => name === "before_tool_call")?.[1] as
      | ((
          event: { toolName: string; toolCallId: string; params: Record<string, unknown> },
          context: { toolName: string; toolCallId: string; agentId: string },
        ) => Promise<{ block?: boolean } | void>)
      | undefined;
    if (!beforeToolCall) {
      throw new Error("missing before_tool_call hook");
    }

    liveEnabled = false;
    await expect(
      beforeToolCall(
        {
          toolName: "onepassword",
          toolCallId: "live-enabled-1",
          params: { action: "get", slug: "deploy", reason: "test live enablement" },
        },
        { toolName: "onepassword", toolCallId: "live-enabled-1", agentId: "agent-a" },
      ),
    ).resolves.toMatchObject({ block: true });

    liveEnabled = true;
    livePolicy = "deny";
    await expect(
      beforeToolCall(
        {
          toolName: "onepassword",
          toolCallId: "live-policy-1",
          params: { action: "get", slug: "deploy", reason: "test live policy" },
        },
        { toolName: "onepassword", toolCallId: "live-policy-1", agentId: "agent-a" },
      ),
    ).resolves.toMatchObject({ block: true });
  });
});
