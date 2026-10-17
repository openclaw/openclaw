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
import { inspectTelegramConversationRouteOwner } from "./conversation-route-owner.test-support.js";

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

  it.each([
    { kind: "group", peerId: "-100123:topic:42", threadId: "42", target: undefined },
    { kind: "direct", peerId: "1001", threadId: undefined, target: "2002" },
  ] as const)(
    "inspects the $kind runtime owner without touching liveness",
    async (conversation) => {
      const touch = vi.fn();
      const resolveByConversation = vi.fn((boundConversation) => ({
        bindingId: "binding-topic",
        targetSessionKey: "agent:runtime:bound",
        targetKind: "session" as const,
        conversation: boundConversation,
        status: "active" as const,
        boundAt: 1,
      }));
      registerSessionBindingAdapter({
        channel: "telegram",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation,
        touch,
      });
      expect(
        await inspectTelegramConversationRouteOwner({
          cfg: {
            channels: {
              telegram: {
                accounts: { default: {} },
                groups: { "-100123": { topics: { "42": { agentId: "configured" } } } },
              },
            },
          },
          accountId: "default",
          conversation,
        }),
      ).toEqual({ kind: "agent", agentId: "runtime" });
      expect(touch).not.toHaveBeenCalled();
      if (conversation.kind === "direct") {
        expect(resolveByConversation).toHaveBeenCalledWith(
          expect.objectContaining({ conversationId: "2002" }),
        );
      }
    },
  );

  const accountCases: Array<{
    name: string;
    accountId?: string;
    cfg: OpenClawConfig;
    expected: Awaited<ReturnType<typeof inspectTelegramConversationRouteOwner>>;
    topic?: boolean;
  }> = [
    {
      name: "temporary adapter gap",
      cfg: { channels: { telegram: { accounts: { default: {} } } } },
      expected: { kind: "unavailable" },
    },
    {
      name: "disabled thread bindings",
      cfg: {
        channels: { telegram: { accounts: { default: {} }, threadBindings: { enabled: false } } },
      },
      expected: { kind: "agent", agentId: "main" },
    },
    {
      name: "removed account",
      accountId: "retired",
      cfg: { channels: { telegram: { accounts: { default: {} } } } },
      expected: null,
    },
    {
      name: "removed default account",
      cfg: { channels: { telegram: { accounts: {} } } },
      expected: null,
    },
    {
      name: "disabled account",
      cfg: { channels: { telegram: { accounts: { default: { enabled: false } } } } },
      expected: null,
    },
    {
      name: "disabled channel",
      cfg: { channels: { telegram: { enabled: false, accounts: { default: { enabled: true } } } } },
      expected: null,
    },
    {
      name: "binding-created account with inherited credentials",
      accountId: "bot-main",
      cfg: {
        agents: { ownership: "explicit", entries: { main: {}, specialist: {} } },
        channels: {
          telegram: { botToken: "123456:synthetic", threadBindings: { enabled: false } },
        },
        bindings: [
          { agentId: "specialist", match: { channel: "telegram", accountId: "bot-main" } },
        ],
      },
      expected: { kind: "agent", agentId: "specialist" },
    },
    {
      name: "removed account with remaining credentials",
      accountId: "retired",
      cfg: {
        channels: {
          telegram: { botToken: "123456:synthetic", threadBindings: { enabled: false } },
        },
      },
      topic: false,
      expected: null,
    },
    {
      name: "binding-only account in explicit multi-account config",
      accountId: "bot-main",
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
      expected: null,
    },
    {
      name: "implicit default alongside named accounts",
      cfg: {
        channels: {
          telegram: {
            botToken: "123456:synthetic",
            accounts: { secondary: { botToken: "654321:synthetic" } },
            threadBindings: { enabled: false },
          },
        },
      },
      topic: false,
      expected: { kind: "agent", agentId: "main" },
    },
    {
      name: "unavailable token on an existing account",
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
      topic: false,
      expected: { kind: "unavailable" },
    },
  ];
  it.each(accountCases)(
    "resolves $name without a runtime adapter",
    async ({ accountId = "default", cfg, expected, topic = true }) => {
      vi.stubEnv("OPENCLAW_TEST_MISSING_TELEGRAM_TOKEN", undefined);
      unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
      expect(
        await inspectTelegramConversationRouteOwner({
          cfg,
          accountId,
          conversation: {
            kind: "group",
            peerId: topic ? "-100123:topic:42" : "-100123",
            ...(topic ? { threadId: "42" } : {}),
          },
        }),
      ).toEqual(expected);
    },
  );
});
