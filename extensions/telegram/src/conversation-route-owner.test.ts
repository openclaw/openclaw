import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  type ConversationBindingInspection,
  inspectConversationBindingAsync,
} from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
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
import { prepareTelegramConversationRouteOwnersAsync } from "./conversation-route-owner.js";
import { inspectTelegramConversationRouteOwner } from "./conversation-route-owner.test-support.js";
import {
  inspectTelegramConversationRouteAsync,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";

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
