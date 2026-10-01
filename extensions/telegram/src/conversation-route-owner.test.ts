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
  resolveTelegramConversationRoute,
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

  describe("a runtime binding when ordinary agent selection is ambiguous", () => {
    // Two agents and no route binding: ordinary routing cannot choose an agent on its own.
    // The conversation's runtime binding already names one, so it must be read first.
    const ambiguousCfg: OpenClawConfig = {
      agents: { list: [{ id: "main" }, { id: "codex" }] },
      bindings: [],
      channels: { telegram: { accounts: { default: {} } } },
    };
    const direct = {
      cfg: ambiguousCfg,
      accountId: "default",
      chatId: 1234,
      senderId: 1234,
      isGroup: false,
      threadSpec: { scope: "none" as const },
    };

    const bindTo = (targetSessionKey: string, metadata?: Record<string, unknown>) => {
      const touchAsync = vi.fn(async () => {});
      registerSessionBindingAdapter({
        channel: "telegram",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: (conversation) => ({
          bindingId: "binding-dm",
          targetSessionKey,
          targetKind: "session",
          conversation,
          status: "active",
          boundAt: 1,
          ...(metadata ? { metadata } : {}),
        }),
        touchAsync,
      });
      return touchAsync;
    };

    it("routes inbound messages to the bound agent", async () => {
      const touchAsync = bindTo("agent:codex:acp:session-1");

      const result = await resolveTelegramConversationRoute(direct);

      expect(result.route.agentId).toBe("codex");
      expect(result.route.sessionKey).toBe("agent:codex:acp:session-1");
      expect(result.bindingMode).toEqual({
        kind: "runtime-bound",
        sessionKey: "agent:codex:acp:session-1",
      });
      expect(touchAsync).toHaveBeenCalledTimes(1);
    });

    it("inspects the bound agent without touching liveness", () => {
      const touch = vi.fn();
      registerSessionBindingAdapter({
        ...adapter,
        resolveByConversation: (conversation) => ({
          bindingId: "binding-dm",
          targetSessionKey: "agent:codex:acp:session-1",
          targetKind: "session",
          conversation,
          status: "active",
          boundAt: 1,
        }),
        touch,
      });

      expect(inspectTelegramConversationRoute(direct).route.agentId).toBe("codex");
      expect(touch).not.toHaveBeenCalled();
    });

    it("uses explicit bound-agent metadata for a sentinel session", async () => {
      bindTo("global", { agentId: "codex" });

      const result = await resolveTelegramConversationRoute(direct);

      expect(result.route.agentId).toBe("codex");
      expect(result.route.sessionKey).toBe("global");
    });

    it("still requires agent selection when the binding names no agent", async () => {
      bindTo("global");

      await expect(resolveTelegramConversationRoute(direct)).rejects.toMatchObject({
        code: "AGENT_SELECTION_REQUIRED",
      });
    });

    // The sync read picks the agent; the awaited read applies the change once, as a
    // revocation or rebind landing between the two would.
    const bindChangingDuringResolution = (change: "revoke" | "rebind") => {
      let targetSessionKey: string | null = "agent:codex:acp:session-1";
      let boundAt = 1;
      let changed = false;
      const read = (conversation: {
        channel: string;
        accountId: string;
        conversationId: string;
      }) =>
        targetSessionKey
          ? {
              bindingId: "binding-dm",
              targetSessionKey,
              targetKind: "session" as const,
              conversation,
              status: "active" as const,
              boundAt,
            }
          : null;
      registerSessionBindingAdapter({
        channel: "telegram",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: read,
        inspectByConversationAsync: async (conversation) => {
          await Promise.resolve();
          if (!changed) {
            changed = true;
            if (change === "revoke") {
              targetSessionKey = null;
            } else {
              targetSessionKey = "agent:main:acp:session-2";
              boundAt = 2;
            }
          }
          return read(conversation);
        },
        touchAsync: vi.fn(async () => {}),
      });
    };

    it("rejects the former owner when the binding is revoked during resolution", async () => {
      bindChangingDuringResolution("revoke");

      await expect(resolveTelegramConversationRoute(direct)).rejects.toMatchObject({
        code: "AGENT_SELECTION_REQUIRED",
      });
    });

    it("routes to the new owner when the binding is replaced during resolution", async () => {
      bindChangingDuringResolution("rebind");

      const result = await resolveTelegramConversationRoute(direct);

      expect(result.route.agentId).toBe("main");
      expect(result.route.sessionKey).toBe("agent:main:acp:session-2");
      expect(result.runtimeBinding?.boundAt).toBe(2);
    });
  });
});
