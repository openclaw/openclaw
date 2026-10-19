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

type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;
type Owner = Awaited<ReturnType<typeof inspectTelegramConversationRouteOwner>>;
const config = (
  telegram: TelegramConfig,
  rest: Omit<OpenClawConfig, "channels"> = {},
): OpenClawConfig => ({ ...rest, channels: { telegram } });
const defaultAccounts = { default: {} };
const unbound = { enabled: false };
const adapterBase = { channel: "telegram", accountId: "default", listBySession: () => [] };
const configured = (overrides: TelegramConfig = {}) =>
  config({ accounts: defaultAccounts, ...overrides });

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
      ...adapterBase,
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
      const resolve = vi.fn((boundConversation) => ({
        bindingId: "binding-topic",
        targetSessionKey: "agent:runtime:bound",
        targetKind: "session" as const,
        conversation: boundConversation,
        status: "active" as const,
        boundAt: 1,
      }));
      registerSessionBindingAdapter({
        ...adapterBase,
        resolveByConversation: resolve,
        touch,
      });
      expect(
        await inspectTelegramConversationRouteOwner({
          cfg: configured({
            groups: { "-100123": { topics: { "42": { agentId: "configured" } } } },
          }),
          accountId: "default",
          conversation,
        }),
      ).toEqual({ kind: "agent", agentId: "runtime" });
      expect(touch).not.toHaveBeenCalled();
      if (conversation.kind === "direct") {
        expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "2002" }));
      }
    },
  );

  const tokenConfig = { botToken: "123456:synthetic", threadBindings: unbound };
  const binding = (agentId: string) => [
    { agentId, match: { channel: "telegram", accountId: "bot-main" } },
  ];
  const mainOwner = { kind: "agent", agentId: "main" } as const;
  const accountCases: [string, OpenClawConfig, Owner, string?, boolean?][] = [
    ["temporary adapter gap", configured(), { kind: "unavailable" }],
    ["disabled thread bindings", configured({ threadBindings: unbound }), mainOwner],
    ["removed account", configured(), null, "retired"],
    ["removed default account", config({ accounts: {} }), null],
    ["disabled account", configured({ accounts: { default: { enabled: false } } }), null],
    [
      "disabled channel",
      configured({ enabled: false, accounts: { default: { enabled: true } } }),
      null,
    ],
    [
      "binding-created account with inherited credentials",
      config(tokenConfig, {
        agents: { ownership: "explicit", entries: { main: {}, specialist: {} } },
        bindings: binding("specialist"),
      }),
      { kind: "agent", agentId: "specialist" },
      "bot-main",
    ],
    ["removed account with remaining credentials", config(tokenConfig), null, "retired", false],
    [
      "binding-only account in explicit multi-account config",
      config({ ...tokenConfig, accounts: defaultAccounts }, { bindings: binding("main") }),
      null,
      "bot-main",
    ],
    [
      "implicit default alongside named accounts",
      config({ ...tokenConfig, accounts: { secondary: { botToken: "654321:synthetic" } } }),
      mainOwner,
      undefined,
      false,
    ],
    [
      "unavailable token on an existing account",
      config({
        botToken: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_TEST_MISSING_TELEGRAM_TOKEN",
        },
      }),
      { kind: "unavailable" },
      undefined,
      false,
    ],
  ];
  it.each(accountCases)(
    "resolves %s without a runtime adapter",
    async (_name, cfg, expected, accountId = "default", topic = true) => {
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
