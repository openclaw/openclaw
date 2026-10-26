import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter as Adapter,
  testing as sessionBindingTesting,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectDiscordConversationRouteOwner as inspectOwner } from "./conversation-route-owner.test-support.js";

function inspect(overrides: Partial<Parameters<typeof inspectOwner>[0]> = {}) {
  return inspectOwner({
    cfg: {},
    accountId: "default",
    conversation: { kind: "channel", peerId: "channel-1" },
    ...overrides,
  });
}

function binding(
  conversation: Parameters<Adapter["resolveByConversation"]>[0],
  targetSessionKey: string,
  metadata?: Record<string, string>,
) {
  return {
    bindingId: "binding-1",
    targetSessionKey,
    targetKind: "session" as const,
    conversation,
    status: "active" as const,
    boundAt: 1,
    metadata,
  };
}

describe("inspectDiscordConversationRouteOwner", () => {
  let adapter: Adapter;

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    const plugin = {
      id: "discord",
      meta: { aliases: [] },
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        createManager: () => ({ stop: () => undefined }),
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    adapter = {
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
    };
    registerSessionBindingAdapter(adapter);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  });

  it.each([
    ["direct", "user-1", "dm-1", "user:user-1", "finance"],
    ["group", "group-dm-1", "group-dm-1", "group-dm-1", "main"],
    ["channel", "channel-1", "channel-1", "channel-1", "main"],
  ] as const)(
    "resolves the %s runtime identity without touching liveness",
    async (kind, peerId, nativeChannelId, conversationId, agentId) => {
      const touch = vi.fn();
      const resolveByConversation = vi.fn((conversation) =>
        kind === "direct" ? binding(conversation, "agent:finance:bound") : null,
      );
      Object.assign(adapter, { resolveByConversation, touch });
      expect(await inspect({ conversation: { kind, peerId, nativeChannelId } })).toEqual({
        kind: "agent",
        agentId,
      });
      expect(resolveByConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId }),
      );
      expect(touch).not.toHaveBeenCalled();
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
    adapter.resolveByConversation = (conversation) =>
      binding(conversation, "agent:review:looks-owned", {
        pluginBindingOwner: "plugin",
        pluginId: "review-plugin",
        pluginRoot: "/plugins/review",
      });

    expect(await inspect()).toEqual({
      kind: "plugin",
      pluginId: "review-plugin",
      fallbackAgentId: "main",
    });
  });
});
