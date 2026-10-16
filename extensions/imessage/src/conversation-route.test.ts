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
import { imessagePlugin } from "./channel.js";
import { resolveIMessageConversationRoute } from "./conversation-route.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: { entries: { main: {}, codex: {} } },
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
      conversationId: directMessage.sender,
    },
    status: "active",
    boundAt: 1,
    ...overrides,
  };
}

function registerBinding(
  binding: SessionBindingRecord | null,
  overrides: Partial<SessionBindingAdapter> = {},
): SessionBindingAdapter {
  const adapter: SessionBindingAdapter = {
    channel: "imessage",
    accountId: "default",
    listBySession: () => (binding ? [binding] : []),
    resolveByConversation: () => binding,
    inspectByConversationAsync: async () => binding,
    touchAsync: vi.fn(async () => {}),
    ...overrides,
  };
  registerSessionBindingAdapter(adapter);
  return adapter;
}

function resolve(cfg: OpenClawConfig = baseCfg) {
  return resolveIMessageConversationRoute({ ...directMessage, cfg });
}

describe("resolveIMessageConversationRoute", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: { id: "imessage", bindings: imessagePlugin.bindings },
        },
      ]),
    );
  });

  afterEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    resetPluginRuntimeStateForTest();
  });

  it.each([
    ["ambiguous", false, []],
    ["conflicting", false, configuredCfg.bindings],
    ["group", true, []],
  ] as const)("selects the bound agent for %s routing", async (_, group, bindings) => {
    const target = group ? "agent:bound:home" : "agent:bound:acp:session-1";
    const binding = createBinding({ targetSessionKey: target });
    const ref = { ...binding.conversation, conversationId: group ? "42" : directMessage.sender };
    binding.conversation = ref;
    const inspect = vi.fn<NonNullable<SessionBindingAdapter["inspectByConversationAsync"]>>(
      async (input) => (input.conversationId === ref.conversationId ? binding : null),
    );
    const { touchAsync: touch } = registerBinding(binding, {
      resolveByConversation: () => (group ? null : binding),
      inspectByConversationAsync: inspect,
    });
    const result = await resolveIMessageConversationRoute({
      ...directMessage,
      isGroup: group,
      peerId: ref.conversationId,
      chatId: group ? 42 : undefined,
      cfg: {
        ...baseCfg,
        bindings: [...bindings],
        session: {
          mainKey: "home",
          groupScope: "main",
          ...(group ? {} : { dmScope: "per-account-channel-peer" as const }),
        },
      },
    });
    expect(result).toMatchObject({
      bindingResolution: null,
      route: {
        agentId: "bound",
        sessionKey: target,
        mainSessionKey: "agent:bound:home",
        groupScope: "main",
        lastRoutePolicy: group ? "main" : "session",
        ...(group ? {} : { dmScope: "per-account-channel-peer", matchedBy: "binding.channel" }),
      },
    });
    expect(touch).toHaveBeenCalledExactlyOnceWith("default:+15555550123", undefined);
    if (group) {
      expect(inspect).toHaveBeenCalledExactlyOnceWith(ref);
    }
  });

  it("uses explicit bound-agent metadata for the global session sentinel", async () => {
    registerBinding(createBinding({ targetSessionKey: "global", metadata: { agentId: "bound" } }));
    const result = await resolve({ ...baseCfg, bindings: [] });
    expect(result.route).toMatchObject({
      agentId: "bound",
      sessionKey: "global",
      mainSessionKey: "agent:bound:main",
    });
  });

  it("retains ordinary agent selection for a sentinel without an explicit bound agent", async () => {
    registerBinding(createBinding({ targetSessionKey: "global" }));
    const result = await resolve(configuredCfg);
    expect(result).toMatchObject({
      route: { agentId: "codex", sessionKey: "global" },
      bindingResolution: null,
    });
    await expect(resolve({ ...baseCfg, bindings: [] })).rejects.toMatchObject({
      code: "AGENT_SELECTION_REQUIRED",
    });
  });

  it.each([
    ["absent", null],
    ["empty", createBinding({ targetSessionKey: " " })],
    ["cron", createBinding({ targetSessionKey: "agent:bound:cron:job:run:proof" })],
  ] as const)("preserves configured readiness for %s runtime bindings", async (_, binding) => {
    const { touchAsync: touch } = registerBinding(binding);
    const result = await resolve(configuredCfg);
    expect(result.route.agentId).toBe("codex");
    expect(result.bindingResolution?.record.targetSessionKey).toBe(result.route.sessionKey);
    expect(result.bindingResolution?.record.conversation).toEqual({
      ...createBinding().conversation,
      parentConversationId: undefined,
    });
    expect(touch).not.toHaveBeenCalled();
    await expect(resolve({ ...baseCfg, bindings: [] })).rejects.toMatchObject({
      code: "AGENT_SELECTION_REQUIRED",
    });
  });

  it("touches plugin-owned bindings without routing to their opaque target", async () => {
    const { touchAsync: touch } = registerBinding(
      createBinding({
        targetSessionKey: "plugin-binding:synthetic:target",
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "synthetic",
          pluginRoot: "/synthetic/plugin",
        },
      }),
    );
    const result = await resolve();
    expect(result).toMatchObject({
      route: { agentId: "main", sessionKey: "agent:main:main" },
      bindingResolution: null,
    });
    expect(touch).toHaveBeenCalledExactlyOnceWith("default:+15555550123", undefined);
  });

  it("rejects malformed targets before recording activity", async () => {
    const { touchAsync: touch } = registerBinding(createBinding({ targetSessionKey: "agent:" }));
    await expect(resolve(configuredCfg)).rejects.toThrow("Malformed agent session key");
    expect(touch).not.toHaveBeenCalled();
  });

  it("waits for activity persistence without replacing the captured route", async () => {
    const binding = createBinding();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let current = binding;
    let settled = false;
    registerBinding(binding, {
      listBySession: () => [current],
      resolveByConversation: () => current,
      inspectByConversationAsync: async () => current,
      touchAsync: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const pending = resolve().then((result) => {
      settled = true;
      return result;
    });
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
      expect((await pending).route).toMatchObject({
        agentId: "bound",
        sessionKey: binding.targetSessionKey,
      });
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });

  it("rejects an inspection whose adapter retired before it settled", async () => {
    const binding = createBinding();
    const adapter = registerBinding(binding, {
      inspectByConversationAsync: async () => {
        unregisterSessionBindingAdapter({ channel: "imessage", accountId: "default", adapter });
        return binding;
      },
    });
    await expect(resolve()).rejects.toThrow("binding owner is temporarily unavailable");
    expect(adapter.touchAsync).not.toHaveBeenCalled();
  });
});
