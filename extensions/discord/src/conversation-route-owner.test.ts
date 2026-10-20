import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  testing as sessionBindingTesting,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectDiscordConversationRouteOwner } from "./conversation-route-owner.test-support.js";

function registerAdapter(overrides: Partial<SessionBindingAdapter> = {}) {
  const adapter: SessionBindingAdapter = {
    channel: "discord",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation: () => null,
    ...overrides,
  };
  registerSessionBindingAdapter(adapter);
  return adapter;
}

function inspect(
  overrides: Partial<Parameters<typeof inspectDiscordConversationRouteOwner>[0]> = {},
) {
  return inspectDiscordConversationRouteOwner({
    cfg: {},
    accountId: "default",
    conversation: { kind: "channel", peerId: "channel-1" },
    ...overrides,
  });
}

describe("inspectDiscordConversationRouteOwner", () => {
  let adapter: SessionBindingAdapter;

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          source: "test",
          plugin: {
            id: "discord",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
              createManager: () => ({ stop: () => undefined }),
            },
          },
        },
      ]),
    );
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    adapter = registerAdapter();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it("uses the direct-user runtime identity without touching liveness", async () => {
    const touch = vi.fn();
    const resolveByConversation = vi.fn((conversation) => ({
      bindingId: "binding-direct",
      targetSessionKey: "agent:finance:bound",
      targetKind: "session" as const,
      conversation,
      status: "active" as const,
      boundAt: 1,
    }));
    registerAdapter({ resolveByConversation, touch });

    expect(
      await inspect({
        conversation: { kind: "direct", peerId: "user-1", nativeChannelId: "dm-1" },
      }),
    ).toEqual({ kind: "agent", agentId: "finance" });
    expect(resolveByConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "user:user-1" }),
    );
    expect(touch).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "group" as const, peerId: "group-dm-1" },
    { kind: "channel" as const, peerId: "channel-1" },
  ])(
    "uses the native channel runtime identity for $kind conversations",
    async ({ kind, peerId }) => {
      const resolveByConversation = vi.fn(() => null);
      registerAdapter({ resolveByConversation });

      await inspect({
        conversation: { kind, peerId, nativeChannelId: peerId },
      });

      expect(resolveByConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: peerId }),
      );
    },
  );

  it("reports temporary adapter unavailability only while bindings are enabled", async () => {
    unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter });
    expect(await inspect()).toEqual({ kind: "unavailable" });
    expect(
      await inspect({
        cfg: { channels: { discord: { threadBindings: { enabled: false } } } },
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
  });

  it.each<[string, string, NonNullable<OpenClawConfig["channels"]>["discord"]]>([
    ["removed account", "retired", { accounts: { default: {} } }],
    ["disabled account", "default", { accounts: { default: { enabled: false } } }],
    ["disabled channel", "default", { enabled: false, accounts: { default: { enabled: true } } }],
  ])(
    "rejects a %s without requiring a runtime binding owner",
    async (_name, accountId, discord) => {
      unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter });
      expect(await inspect({ cfg: { channels: { discord } }, accountId })).toBeNull();
    },
  );

  it("preserves explicit plugin ownership independently of the target session key", async () => {
    registerAdapter({
      resolveByConversation: (conversation) => ({
        bindingId: "binding-plugin",
        targetSessionKey: "agent:review:looks-owned",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1,
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "review-plugin",
          pluginRoot: "/plugins/review",
        },
      }),
    });

    expect(await inspect()).toEqual({
      kind: "plugin",
      pluginId: "review-plugin",
      fallbackAgentId: "main",
    });
  });
});
