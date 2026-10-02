// Imessage tests cover conversation route plugin behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  testing as sessionBindingTesting,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  matchIMessageAcpConversation,
  normalizeIMessageAcpConversationId,
} from "./conversation-id.js";
import { resolveIMessageConversationRoute } from "./conversation-route.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "main" }, { id: "codex" }],
  },
  bindings: [{ agentId: "main", match: { channel: "imessage", accountId: "default" } }],
} satisfies OpenClawConfig;

const configuredCfg = {
  ...baseCfg,
  bindings: [
    ...baseCfg.bindings,
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "imessage",
        accountId: "default",
        peer: { kind: "direct", id: "+15555550123" },
      },
    },
  ],
} satisfies OpenClawConfig;

const directMessage = {
  accountId: "default",
  isGroup: false,
  peerId: "+15555550123",
  sender: "+15555550123",
};

function createBinding(overrides: Partial<SessionBindingRecord> = {}): SessionBindingRecord {
  return {
    bindingId: "default:+15555550123",
    targetSessionKey: "agent:bound:acp:session-1",
    targetKind: "session",
    conversation: {
      channel: "imessage",
      accountId: "default",
      conversationId: "+15555550123",
    },
    status: "active",
    boundAt: 1,
    ...overrides,
  };
}

function registerBinding(binding: SessionBindingRecord | null) {
  const touchAsync = vi.fn(async () => {});
  registerSessionBindingAdapter({
    channel: "imessage",
    accountId: "default",
    listBySession: () => (binding ? [binding] : []),
    resolveByConversation: () => binding,
    inspectByConversationAsync: async () => binding,
    touchAsync,
  });
  return touchAsync;
}

describe("resolveIMessageConversationRoute", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: {
            id: "imessage",
            bindings: {
              compileConfiguredBinding: ({ conversationId }) =>
                normalizeIMessageAcpConversationId(conversationId),
              matchInboundConversation: ({ compiledBinding, conversationId }) =>
                matchIMessageAcpConversation({
                  bindingConversationId: compiledBinding.conversationId,
                  conversationId,
                }),
            } satisfies NonNullable<ChannelPlugin["bindings"]>,
          },
        },
      ]),
    );
  });

  afterEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    resetPluginRuntimeStateForTest();
  });

  it("preserves configured ACP binding ownership for deferred target readiness", async () => {
    const result = await resolveIMessageConversationRoute({
      cfg: configuredCfg,
      accountId: "default",
      isGroup: false,
      peerId: "+15555550123",
      sender: "+15555550123",
    });

    expect(result.route.agentId).toBe("codex");
    expect(result.bindingResolution?.record.conversation).toEqual({
      channel: "imessage",
      accountId: "default",
      conversationId: "+15555550123",
      parentConversationId: undefined,
    });
    expect(result.bindingResolution?.record.targetSessionKey).toBe(result.route.sessionKey);
  });

  it("lets runtime iMessage conversation bindings override default routing", async () => {
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "imessage",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: (ref) =>
        ref.conversationId === "+15555550123"
          ? {
              bindingId: "default:+15555550123",
              targetSessionKey: "agent:codex:acp:bound-1",
              targetKind: "session",
              conversation: {
                channel: "imessage",
                accountId: "default",
                conversationId: "+15555550123",
              },
              status: "active",
              boundAt: Date.now(),
              metadata: { boundBy: "user-1" },
            }
          : null,
      touch,
    });

    const result = await resolveIMessageConversationRoute({
      cfg: configuredCfg,
      accountId: "default",
      isGroup: false,
      peerId: "+15555550123",
      sender: "+15555550123",
    });

    expect(result.route.agentId).toBe("codex");
    expect(result.route.sessionKey).toBe("agent:codex:acp:bound-1");
    expect(result.route.matchedBy).toBe("binding.channel");
    expect(result.bindingResolution).toBeNull();
    expect(touch).toHaveBeenCalledWith("default:+15555550123", undefined);
  });

  it.each(["ambiguous", "conflicting"] as const)(
    "selects the bound agent before %s ordinary routing",
    async (routing) => {
      const touch = registerBinding(createBinding());
      const cfg: OpenClawConfig = {
        ...baseCfg,
        session: { mainKey: "home", dmScope: "per-account-channel-peer", groupScope: "main" },
        bindings: routing === "ambiguous" ? [] : configuredCfg.bindings,
      };

      const result = await resolveIMessageConversationRoute({ ...directMessage, cfg });

      expect(result.route).toMatchObject({
        agentId: "bound",
        sessionKey: "agent:bound:acp:session-1",
        mainSessionKey: "agent:bound:home",
        dmScope: "per-account-channel-peer",
        groupScope: "main",
        lastRoutePolicy: "session",
        matchedBy: "binding.channel",
      });
      expect(result.bindingResolution).toBeNull();
      expect(touch).toHaveBeenCalledExactlyOnceWith("default:+15555550123", undefined);
    },
  );

  it.each(["global", "unknown"] as const)(
    "uses explicit bound-agent metadata for the %s session sentinel",
    async (targetSessionKey) => {
      registerBinding(createBinding({ targetSessionKey, metadata: { agentId: "bound" } }));
      const result = await resolveIMessageConversationRoute({
        ...directMessage,
        cfg: { ...baseCfg, bindings: [] },
      });
      expect(result.route).toMatchObject({
        agentId: "bound",
        sessionKey: targetSessionKey,
        mainSessionKey: "agent:bound:main",
      });
    },
  );

  it("retains ordinary agent selection for a sentinel without an explicit bound agent", async () => {
    registerBinding(createBinding({ targetSessionKey: "global" }));
    const result = await resolveIMessageConversationRoute({ ...directMessage, cfg: configuredCfg });
    expect(result.route).toMatchObject({ agentId: "codex", sessionKey: "global" });
    expect(result.bindingResolution).toBeNull();
    await expect(
      Promise.resolve().then(() =>
        resolveIMessageConversationRoute({ ...directMessage, cfg: { ...baseCfg, bindings: [] } }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
  });

  it.each([
    { name: "absent", binding: null },
    { name: "empty", binding: createBinding({ targetSessionKey: " " }) },
    {
      name: "cron",
      binding: createBinding({ targetSessionKey: "agent:bound:cron:job:run:proof" }),
    },
  ])("preserves configured readiness for $name runtime bindings", async ({ binding }) => {
    const touch = registerBinding(binding);
    const result = await resolveIMessageConversationRoute({ ...directMessage, cfg: configuredCfg });
    expect(result.route.agentId).toBe("codex");
    expect(result.bindingResolution?.record.targetSessionKey).toBe(result.route.sessionKey);
    expect(result.bindingResolution?.record.conversation.conversationId).toBe(directMessage.sender);
    expect(touch).not.toHaveBeenCalled();
    await expect(
      Promise.resolve().then(() =>
        resolveIMessageConversationRoute({ ...directMessage, cfg: { ...baseCfg, bindings: [] } }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
  });

  it("touches plugin-owned bindings without routing to their opaque target", async () => {
    const touch = registerBinding(
      createBinding({
        targetSessionKey: "plugin-binding:synthetic:target",
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "synthetic",
          pluginRoot: "/synthetic/plugin",
        },
      }),
    );
    const result = await resolveIMessageConversationRoute({ ...directMessage, cfg: baseCfg });
    expect(result.route).toMatchObject({ agentId: "main", sessionKey: "agent:main:main" });
    expect(result.bindingResolution).toBeNull();
    expect(touch).toHaveBeenCalledExactlyOnceWith("default:+15555550123", undefined);
  });

  it("rejects malformed targets before recording activity", async () => {
    const touch = registerBinding(createBinding({ targetSessionKey: "agent:" }));
    await expect(
      Promise.resolve().then(() =>
        resolveIMessageConversationRoute({ ...directMessage, cfg: configuredCfg }),
      ),
    ).rejects.toThrow("Malformed agent session key");
    expect(touch).not.toHaveBeenCalled();
  });

  it("uses the group conversation identity and the bound agent's global scope", async () => {
    const binding = createBinding({
      targetSessionKey: "agent:bound:home",
      conversation: { channel: "imessage", accountId: "default", conversationId: "42" },
    });
    const inspect = vi.fn<NonNullable<SessionBindingAdapter["inspectByConversationAsync"]>>(
      async (ref) => (ref.conversationId === "42" ? binding : null),
    );
    registerSessionBindingAdapter({
      channel: "imessage",
      accountId: "default",
      listBySession: () => [binding],
      resolveByConversation: () => null,
      inspectByConversationAsync: inspect,
      touchAsync: async () => {},
    });
    const result = await resolveIMessageConversationRoute({
      ...directMessage,
      isGroup: true,
      peerId: "42",
      chatId: 42,
      cfg: { ...baseCfg, bindings: [], session: { mainKey: "home", groupScope: "main" } },
    });
    expect(result.route).toMatchObject({
      agentId: "bound",
      sessionKey: "agent:bound:home",
      mainSessionKey: "agent:bound:home",
      groupScope: "main",
      lastRoutePolicy: "main",
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(binding.conversation);
  });

  it("waits for activity persistence without replacing the captured route", async () => {
    const binding = createBinding();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let current = binding;
    let settled = false;
    registerSessionBindingAdapter({
      channel: "imessage",
      accountId: "default",
      listBySession: () => [current],
      resolveByConversation: () => current,
      inspectByConversationAsync: async () => current,
      touchAsync: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const pending = resolveIMessageConversationRoute({ ...directMessage, cfg: baseCfg }).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Route settled before activity persistence");
        }),
      ]);
      expect(settled).toBe(false);
      current = createBinding({ boundAt: 2, targetSessionKey: "agent:replacement:acp:session-2" });
      release.resolve();
      const result = await pending;
      expect(result.route).toMatchObject({
        agentId: "bound",
        sessionKey: binding.targetSessionKey,
      });
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });

  it("rejects an inspection whose adapter retired before it settled", async () => {
    const touch = vi.fn(async () => {});
    const binding = createBinding();
    const adapter: SessionBindingAdapter = {
      channel: "imessage",
      accountId: "default",
      listBySession: () => [binding],
      resolveByConversation: () => binding,
      inspectByConversationAsync: async () => {
        unregisterSessionBindingAdapter({ channel: "imessage", accountId: "default", adapter });
        return binding;
      },
      touchAsync: touch,
    };
    registerSessionBindingAdapter(adapter);
    await expect(
      resolveIMessageConversationRoute({ ...directMessage, cfg: baseCfg }),
    ).rejects.toThrow("binding owner is temporarily unavailable");
    expect(touch).not.toHaveBeenCalled();
  });
});
