import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  type ConversationBindingInspection,
  inspectConversationBindingAsync,
} from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { registerSessionBindingAdapter, testing } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";
import { prepareTelegramConversationRouteOwnersAsync } from "./conversation-route-owner.js";
import { inspectTelegramConversationRouteOwner } from "./conversation-route-owner.test-support.js";
import {
  inspectTelegramConversationRouteAsync,
  resolveTelegramConversationRoute,
  resolveTelegramTargetSession,
} from "./conversation-route.js";

const tryReadSecretFileSyncMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("reply mode must not read Telegram credentials");
  }),
);

vi.mock("openclaw/plugin-sdk/secret-file-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/secret-file-runtime")>()),
  tryReadSecretFileSync: tryReadSecretFileSyncMock,
}));

const messaging = telegramPlugin.messaging!;
type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;
function config(
  telegram: TelegramConfig,
  rest: Omit<OpenClawConfig, "channels"> = {},
): OpenClawConfig {
  return { ...rest, channels: { telegram } };
}
type RouteParams = Parameters<NonNullable<typeof messaging.resolveOutboundSessionRoute>>[0];
function resolveRoute(target: string, params: Partial<Omit<RouteParams, "target">> = {}) {
  return messaging.resolveOutboundSessionRoute!({ cfg: {}, agentId: "main", target, ...params });
}
const session = (sessionKey: string, extra: Record<string, unknown> = {}) => ({
  sessionKey,
  baseSessionKey: sessionKey,
  ...extra,
});

describe("telegram session route", () => {
  it("aligns isolated direct topic sessions with inbound reply routing", async () => {
    const route = await resolveRoute("104506878:topic:174872", {
      cfg: { session: { dmScope: "per-account-channel-peer" } },
      agentId: "finance",
      accountId: "finance",
    });
    expect(route).toMatchObject(
      session("agent:finance:telegram:finance:direct:104506878", {
        sessionKey: "agent:finance:telegram:finance:direct:104506878:thread:104506878:174872",
        threadId: 174872,
        from: "telegram:104506878:topic:174872",
      }),
    );
  });

  it.each(["12345", "@alice"])("recovers isolated direct topic routes for %s", async (target) => {
    const baseSessionKey = `agent:main:telegram:direct:${target}`;
    const sessionKey = `${baseSessionKey}:thread:${target}:99`;
    const route = await resolveRoute(target, {
      cfg: { session: { dmScope: "per-channel-peer" } },
      currentSessionKey: sessionKey,
    });
    expect(route).toMatchObject(
      session(baseSessionKey, { sessionKey, threadId: 99, from: `telegram:${target}:topic:99` }),
    );
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const route = await resolveRoute("12345", {
      currentSessionKey: "agent:main:main:thread:12345:99",
    });

    expect(route).toMatchObject(session("agent:main:main", { recipientSessionExact: true }));
    expect(route?.threadId).toBeUndefined();
  });

  it.each([
    [undefined, "agent:main:telegram:work:direct:12345"],
    ["work", "agent:main:main"],
  ])("classifies direct sessions with defaultAccount=%s", async (defaultAccount, expected) => {
    const route = await resolveRoute("12345", {
      cfg: config({ defaultAccount, accounts: { work: {}, personal: {} } }),
      accountId: "work",
    });
    expect(route).toMatchObject(session(expected, { recipientSessionExact: true }));
  });

  const bindings = [
    { agentId: "fallback", match: { channel: "telegram", accountId: "*" } },
    { agentId: "drafts", match: { channel: "telegram", accountId: "drafts" } },
  ];
  const boundNamedAccountCfg = config(
    { accounts: { default: {}, drafts: {} } },
    { session: { dmScope: "per-channel-peer" }, bindings },
  );

  it.each([
    { dmScope: undefined, baseSessionKey: "agent:drafts:telegram:direct:12345" },
    {
      dmScope: "per-account-channel-peer" as const,
      baseSessionKey: "agent:drafts:telegram:drafts:direct:12345",
    },
  ])(
    "aligns explicitly bound DM topics with binding scope $dmScope",
    async ({ dmScope, baseSessionKey }) => {
      const cfg = {
        ...boundNamedAccountCfg,
        bindings: bindings.map((binding) =>
          Object.assign({}, binding, binding.agentId === "drafts" ? { session: { dmScope } } : {}),
        ),
      };
      const route = await resolveRoute("12345", {
        cfg,
        agentId: "drafts",
        accountId: "drafts",
        threadId: 21,
        currentSessionKey: "agent:drafts:telegram:direct:12345:thread:12345:10",
      });
      const { route: inboundRoute } = await resolveTelegramConversationRoute({
        cfg,
        accountId: "drafts",
        chatId: 12345,
        isGroup: false,
        threadSpec: { id: 21, scope: "dm" },
        senderId: 12345,
      });
      const inboundSessionKey = resolveTelegramTargetSession({
        cfg,
        route: inboundRoute,
        chatId: 12345,
        isGroup: false,
        senderId: 12345,
        dmThreadId: 21,
        botHasTopicsEnabled: true,
      });

      expect(inboundSessionKey).toBe(`${baseSessionKey}:thread:12345:21`);
      expect(route).toMatchObject({ sessionKey: inboundSessionKey, baseSessionKey, threadId: 21 });
    },
  );

  it.each([
    ["fallback", boundNamedAccountCfg],
    [
      "drafts",
      {
        session: boundNamedAccountCfg.session,
        channels: boundNamedAccountCfg.channels,
        agents: { ownership: "explicit", entries: { drafts: {}, other: {} } },
      },
    ],
  ] satisfies [string, RouteParams["cfg"]][])(
    "keeps caller %s isolated when no binding selects it",
    async (agentId, cfg) => {
      const route = await resolveRoute("12345", { cfg, agentId, accountId: "drafts" });
      expect(route?.sessionKey).toBe(`agent:${agentId}:telegram:drafts:direct:12345`);
    },
  );

  it.each(["direct-topic", "topic"])("keeps %s group routes distinct", async (scope) => {
    const target = `-100:${scope}:99`;
    expect(await resolveRoute(target)).toMatchObject({
      sessionKey: `agent:main:telegram:group:${target}`,
      from: `telegram:group:${target}`,
      to: `telegram:${target}`,
      threadId: 99,
    });
  });

  it.each([
    ["-1001:Topic:77", "77", "-1001:topic:77"],
    ["-1001:direct-topic:77", "direct-topic:77", "-1001:direct-topic:77"],
  ])("round-trips registered session topic %s", (rawId, expectedThread, target) => {
    const conversation = messaging.resolveSessionConversation!({ kind: "group", rawId });
    expect(conversation).toMatchObject({
      id: "-1001",
      threadId: expectedThread,
      parentConversationCandidates: ["-1001"],
    });
    const { id, threadId } = conversation!;
    expect(messaging.resolveSessionTarget!({ kind: "group", id, threadId })).toBe(target);
  });

  it("keeps topicless sessions and username targets outside topic parsing", () => {
    expect(messaging.resolveSessionConversation!({ kind: "group", rawId: "-1001" })).toBeNull();
    expect(messaging.resolveSessionTarget!({ kind: "channel", id: "@OpenClawTeam" })).toBe(
      "@OpenClawTeam",
    );
  });

  it("skips unusable command candidates and preserves a later direct topic", () => {
    expect(
      telegramPlugin.bindings?.resolveCommandConversation?.({
        accountId: "default",
        originatingTo: "telegram:-100123",
        commandTo: "telegram:-100123:direct-topic:77",
      }),
    ).toEqual({
      conversationId: "-100123:direct-topic:77",
      parentConversationId: "-100123",
    });
  });

  it("does not treat directory-resolved usernames as canonical session ids", async () => {
    const route = await resolveRoute("@team", {
      resolvedTarget: { to: "@team", kind: "group", source: "directory" },
    });

    expect(route).toMatchObject({ peer: { kind: "group" }, recipientSessionExact: false });
  });
});

type Owner = Awaited<ReturnType<typeof inspectTelegramConversationRouteOwner>>;
const defaultAccounts = { default: {} };
const unbound = { enabled: false };
const adapterBase = { channel: "telegram", accountId: "default", listBySession: () => [] };
const configured = (overrides: TelegramConfig = {}) =>
  config({ accounts: defaultAccounts, ...overrides });

describe("inspectTelegramConversationRouteOwner", () => {
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

  describe("a runtime binding when ordinary agent selection is ambiguous", () => {
    // Two agents and no route binding: ordinary routing cannot choose an agent on its own.
    // The conversation's runtime binding already names one, so it must be read first.
    const ambiguousCfg: OpenClawConfig = {
      agents: { entries: { main: {}, codex: {} } },
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

    it("inspects the bound agent without touching liveness", async () => {
      const touchAsync = bindTo("agent:codex:acp:session-1");

      const result = await inspectTelegramConversationRouteAsync(direct);

      expect(result.route.agentId).toBe("codex");
      expect(touchAsync).not.toHaveBeenCalled();
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

    // The awaited inspection applies the change once, as a revocation or rebind landing just
    // before routing would; agent selection must follow the inspected binding.
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

    // Delivery prepares the owner once and reads it again at the effect with fresh binding
    // facts; a change landing in between must reach agent selection, not the prepared owner.
    const prepareOwnerThenChange = async (change: "revoke" | "rebind") => {
      let targetSessionKey: string | null = "agent:codex:acp:session-1";
      registerSessionBindingAdapter({
        channel: "telegram",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: (conversation) =>
          targetSessionKey
            ? {
                bindingId: "binding-dm",
                targetSessionKey,
                targetKind: "session",
                conversation,
                status: "active",
                boundAt: 1,
              }
            : null,
      });
      let refs: Parameters<typeof inspectConversationBindingAsync>[0][] = [];
      let current: ConversationBindingInspection[] = [];
      const refresh = async () => {
        current = await Promise.all(refs.map(inspectConversationBindingAsync));
      };
      const [readOwner] = await prepareTelegramConversationRouteOwnersAsync(
        [
          {
            cfg: ambiguousCfg,
            accountId: "default",
            conversation: { kind: "direct", peerId: "1234" },
          },
        ],
        async (prepared) => {
          refs = [...prepared];
          await refresh();
          return () => current;
        },
      );
      const preparedOwner = readOwner!();
      targetSessionKey = change === "revoke" ? null : "agent:main:acp:session-2";
      await refresh();
      return { preparedOwner, readOwner: readOwner! };
    };

    it("rejects the former owner when the binding is revoked after preparation", async () => {
      const { preparedOwner, readOwner } = await prepareOwnerThenChange("revoke");

      expect(preparedOwner).toEqual({ kind: "agent", agentId: "codex" });
      expect(() => readOwner()).toThrow(
        expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
      );
    });

    it("selects the new owner when the binding is replaced after preparation", async () => {
      const { preparedOwner, readOwner } = await prepareOwnerThenChange("rebind");

      expect(preparedOwner).toEqual({ kind: "agent", agentId: "codex" });
      expect(readOwner()).toEqual({ kind: "agent", agentId: "main" });
    });
  });
});

describe("telegramPlugin reply threading", () => {
  it.each([
    ["first", { accounts: { sut: { tokenFile: "/tmp/must-not-read", replyToMode: "first" } } }],
    [
      "all",
      {
        replyToMode: "all",
        accounts: {
          sut: { botToken: { source: "file", provider: "telegram_token", id: "value" } },
        },
      },
    ],
    ["off", { replyToMode: "all", accounts: { sut: { replyToMode: "off" } } }],
  ] satisfies [string, NonNullable<OpenClawConfig["channels"]>["telegram"]][])(
    "resolves reply mode %s without reading credentials",
    (expected, telegram) => {
      tryReadSecretFileSyncMock.mockClear();
      const cfg = config(telegram);
      expect(telegramPlugin.threading?.resolveReplyToMode?.({ cfg, accountId: "sut" })).toBe(
        expected,
      );
      expect(tryReadSecretFileSyncMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["-100123", "telegram:-100123", true],
    ["telegram:-100123", "-100123", true],
    ["-100123:topic:77", "telegram:-100123:77", true],
    ["1234:topic:77", "telegram:1234:topic:77", true],
    ["1234:topic:77", "telegram:1234:topic:78", false],
    ["-100123:direct-topic:77", "telegram:-100123:direct-topic:77", true],
    ["-100123:direct-topic:77", "telegram:-100123:direct-topic:78", false],
    ["-100123:topic:77", "telegram:-100123:direct-topic:77", false],
    ["-100123:topic:77", "telegram:-100123:topic:78", false],
    ["-100456", "telegram:-100123", false],
  ] as const)(
    "matches canonical target %s against current channel %s: %s",
    (target, currentChannelId, expected) => {
      expect(
        telegramPlugin.threading?.matchesToolContextTarget?.({
          target,
          toolContext: { currentChannelId },
        }),
      ).toBe(expected);
    },
  );

  it("recovers missing thread metadata from the target only for the same chat", () => {
    const cfg: OpenClawConfig = {};
    const toolContext = telegramPlugin.threading?.buildToolContext?.({
      cfg,
      accountId: "default",
      context: { To: "telegram:-1001:topic:77", CurrentMessageId: "msg-1" },
    });
    expect(
      ["telegram:-1001", "telegram:-1002"].map((to) =>
        telegramPlugin.threading?.resolveAutoThreadId?.({ cfg, to, toolContext }),
      ),
    ).toEqual(["77", undefined]);
  });

  it.each([
    ["telegram:1234", "telegram:1234", "533274", "533274"],
    ["telegram:-1001:topic:99", "telegram:-1001:topic:77", "77", undefined],
  ] as const)(
    "respects the registered thread selection for %s",
    (to, currentChannelId, currentThreadTs, expected) => {
      expect(
        telegramPlugin.threading?.resolveAutoThreadId?.({
          cfg: {},
          to,
          toolContext: { currentChannelId, currentThreadTs },
        }),
      ).toBe(expected);
    },
  );
});
