import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  testing,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectTelegramConversationRouteOwner } from "./conversation-route-owner.js";
import {
  inspectTelegramConversationRoute,
  touchTelegramConversationRoute,
} from "./conversation-route.js";

describe("inspectTelegramConversationRouteOwner", () => {
  let adapter: SessionBindingAdapter;

  beforeEach(() => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            id: "telegram",
            meta: { aliases: [] },
            conversationBindings: {
              supportsCurrentConversationBinding: true,
              createManager: () => ({ stop: () => undefined }),
            },
          },
        },
      ]),
    );
    testing.resetSessionBindingAdaptersForTests();
    adapter = {
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => null,
    };
    registerSessionBindingAdapter(adapter);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    testing.resetSessionBindingAdaptersForTests();
    vi.unstubAllEnvs();
  });

  it("replays topic config and runtime precedence without touching liveness", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: { default: {} },
          groups: { "-100123": { topics: { "42": { agentId: "configured" } } } },
        },
      },
    };
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => ({
        bindingId: "binding-topic",
        targetSessionKey: "agent:runtime:bound",
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: 1,
      }),
      touch,
    });

    expect(
      inspectTelegramConversationRouteOwner({
        cfg,
        accountId: "default",
        conversation: { kind: "group", peerId: "-100123:topic:42", threadId: "42" },
      }),
    ).toEqual({ kind: "agent", agentId: "runtime" });
    expect(touch).not.toHaveBeenCalled();
  });

  it.each([
    "unchanged",
    "reassigned",
    "replaced",
    "reassigned during touch",
    "replaced during touch",
  ])("touches only the captured native binding after authorization: %s", async (change) => {
    const touch = vi.fn();
    let targetSessionKey = "agent:original:bound";
    let boundAt = 1;
    const touchAsync = vi.fn(async () => {
      await Promise.resolve();
      if (change === "reassigned during touch") {
        targetSessionKey = "agent:replacement:bound";
      } else if (change === "replaced during touch") {
        boundAt = 2;
      }
    });
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (conversation) => ({
        bindingId: "binding-topic",
        targetSessionKey,
        targetKind: "session",
        conversation,
        status: "active",
        boundAt,
      }),
      touch,
      ...(change.endsWith("during touch") ? { touchAsync } : {}),
    });
    const inspected = inspectTelegramConversationRoute({
      cfg: { channels: { telegram: { accounts: { default: {} } } } },
      accountId: "default",
      chatId: -100123,
      isGroup: true,
      threadSpec: { scope: "forum", id: 42 },
    });
    expect(touch).not.toHaveBeenCalled();
    if (change === "reassigned") {
      targetSessionKey = "agent:replacement:bound";
    }
    if (change === "replaced") {
      boundAt = 2;
    }
    if (change === "unchanged") {
      await touchTelegramConversationRoute(inspected);
      expect(touch).toHaveBeenCalledWith("binding-topic", undefined);
    } else {
      await expect(touchTelegramConversationRoute(inspected)).rejects.toThrow(
        "command route changed",
      );
      expect(touch).not.toHaveBeenCalled();
    }
    expect(touchAsync).toHaveBeenCalledTimes(change.endsWith("during touch") ? 1 : 0);
    expect(inspected.route.sessionKey).toBe("agent:original:bound");
  });

  it("reports a temporary adapter gap only while thread bindings are enabled", () => {
    unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
    const conversation = {
      kind: "group" as const,
      peerId: "-100123:topic:42",
      threadId: "42",
    };

    expect(
      inspectTelegramConversationRouteOwner({
        cfg: { channels: { telegram: { accounts: { default: {} } } } },
        accountId: "default",
        conversation,
      }),
    ).toEqual({ kind: "unavailable" });
    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {
          channels: { telegram: { accounts: { default: {} }, threadBindings: { enabled: false } } },
        },
        accountId: "default",
        conversation,
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
  });

  it("keeps the direct sender route separate from its delivery chat", () => {
    const resolveByConversation = vi.fn((conversation) => ({
      bindingId: "binding-dm",
      targetSessionKey: "agent:runtime:bound",
      targetKind: "session" as const,
      conversation,
      status: "active" as const,
      boundAt: 1,
    }));
    registerSessionBindingAdapter({
      channel: "telegram",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation,
    });

    expect(
      inspectTelegramConversationRouteOwner({
        cfg: { channels: { telegram: { accounts: { default: {} } } } },
        accountId: "default",
        conversation: { kind: "direct", peerId: "1001", target: "2002" },
      }),
    ).toEqual({ kind: "agent", agentId: "runtime" });
    expect(resolveByConversation).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "2002" }),
    );
  });
  const inactiveAccounts: Array<{
    name: string;
    accountId: string;
    telegram: NonNullable<OpenClawConfig["channels"]>["telegram"];
  }> = [
    {
      name: "removed account",
      accountId: "retired",
      telegram: { accounts: { default: {} } },
    },
    {
      name: "removed default account",
      accountId: "default",
      telegram: { accounts: {} },
    },
    {
      name: "disabled account",
      accountId: "default",
      telegram: { accounts: { default: { enabled: false } } },
    },
    {
      name: "disabled channel",
      accountId: "default",
      telegram: { enabled: false, accounts: { default: { enabled: true } } },
    },
  ];
  it.each(inactiveAccounts)(
    "rejects a $name without requiring a runtime binding owner",
    ({ accountId, telegram }) => {
      unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });

      expect(
        inspectTelegramConversationRouteOwner({
          cfg: { channels: { telegram } },
          accountId,
          conversation: { kind: "group", peerId: "-100123:topic:42", threadId: "42" },
        }),
      ).toBeNull();
    },
  );

  it("keeps binding-created accounts on inherited single-bot credentials", () => {
    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {
          agents: { ownership: "explicit", entries: { main: {}, specialist: {} } },
          channels: {
            telegram: { botToken: "123456:synthetic", threadBindings: { enabled: false } },
          },
          bindings: [
            { agentId: "specialist", match: { channel: "telegram", accountId: "bot-main" } },
          ],
        },
        accountId: "bot-main",
        conversation: { kind: "group", peerId: "-100123:topic:42", threadId: "42" },
      }),
    ).toEqual({ kind: "agent", agentId: "specialist" });
  });

  it("does not recreate a removed account from remaining single-bot credentials", () => {
    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {
          channels: {
            telegram: { botToken: "123456:synthetic", threadBindings: { enabled: false } },
          },
        },
        accountId: "retired",
        conversation: { kind: "group", peerId: "-100123" },
      }),
    ).toBeNull();
  });

  it("rejects binding-only accounts in an explicit multi-account setup", () => {
    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {
          channels: {
            telegram: {
              botToken: "123456:synthetic",
              accounts: { default: {} },
              threadBindings: { enabled: false },
            },
          },
          bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "bot-main" } }],
        },
        accountId: "bot-main",
        conversation: { kind: "group", peerId: "-100123:topic:42", threadId: "42" },
      }),
    ).toBeNull();
  });

  it("keeps an implicit default alongside named accounts", () => {
    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {
          channels: {
            telegram: {
              botToken: "123456:synthetic",
              accounts: { secondary: { botToken: "654321:synthetic" } },
              threadBindings: { enabled: false },
            },
          },
        },
        accountId: "default",
        conversation: { kind: "group", peerId: "-100123" },
      }),
    ).toEqual({ kind: "agent", agentId: "main" });
  });

  it("does not confuse an unavailable token with a removed account", () => {
    vi.stubEnv("OPENCLAW_TEST_MISSING_TELEGRAM_TOKEN", undefined);
    unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
    expect(
      inspectTelegramConversationRouteOwner({
        cfg: {
          channels: {
            telegram: {
              botToken: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_TEST_MISSING_TELEGRAM_TOKEN",
              },
            },
          },
        },
        accountId: "default",
        conversation: { kind: "group", peerId: "-100123" },
      }),
    ).toEqual({ kind: "unavailable" });
  });
});
