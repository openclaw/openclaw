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
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation,
      touch,
    });

    expect(
      await inspectDiscordConversationRouteOwner({
        cfg: {},
        accountId: "default",
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
      registerSessionBindingAdapter({
        channel: "discord",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation,
      });

      await inspectDiscordConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind, peerId, nativeChannelId: peerId },
      });

      expect(resolveByConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: peerId }),
      );
    },
  );

  it("reports temporary adapter unavailability only while bindings are enabled", async () => {
    unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter });
    const conversation = { kind: "channel" as const, peerId: "channel-1" };

    expect(
      await inspectDiscordConversationRouteOwner({ cfg: {}, accountId: "default", conversation }),
    ).toEqual({ kind: "unavailable" });
    expect(
      await inspectDiscordConversationRouteOwner({
        cfg: { channels: { discord: { threadBindings: { enabled: false } } } },
        accountId: "default",
        conversation,
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
  });

  it.each([
    {
      name: "removed account",
      accountId: "retired",
      discord: { accounts: { default: {} } },
    },
    {
      name: "disabled account",
      accountId: "default",
      discord: { accounts: { default: { enabled: false } } },
    },
    {
      name: "disabled channel",
      accountId: "default",
      discord: { enabled: false, accounts: { default: { enabled: true } } },
    },
  ] satisfies Array<{
    name: string;
    accountId: string;
    discord: NonNullable<OpenClawConfig["channels"]>["discord"];
  }>)(
    "rejects a $name without requiring a runtime binding owner",
    async ({ accountId, discord }) => {
      unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter });
      expect(
        await inspectDiscordConversationRouteOwner({
          cfg: { channels: { discord } },
          accountId,
          conversation: { kind: "channel", peerId: "channel-1" },
        }),
      ).toBeNull();
    },
  );

  it("preserves explicit plugin ownership independently of the target session key", async () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      listBySession: () => [],
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

    expect(
      await inspectDiscordConversationRouteOwner({
        cfg: {},
        accountId: "default",
        conversation: { kind: "channel", peerId: "channel-1" },
      }),
    ).toEqual({ kind: "plugin", pluginId: "review-plugin", fallbackAgentId: "main" });
  });
});
