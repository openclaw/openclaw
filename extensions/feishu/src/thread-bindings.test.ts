import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { registerFeishuSubagentHooks } from "../subagent-hooks-api.js";
import {
  createFeishuThreadBindingManager as createFeishuThreadBindingManagerImpl,
  getFeishuThreadBindingManager,
} from "./thread-bindings.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

type FeishuThreadBindingManager = ReturnType<typeof createFeishuThreadBindingManagerImpl>;
const trackedManagers: FeishuThreadBindingManager[] = [];
const account = { channel: "feishu", accountId: "default" };
const service = getSessionBindingService();
const startedAt = 1_700_000_000_000;

function conversationRef(conversationId: string, parentConversationId?: string) {
  return { ...account, conversationId, ...(parentConversationId ? { parentConversationId } : {}) };
}

function bindTo(
  conversation: ReturnType<typeof conversationRef>,
  targetSessionKey: string,
  metadata?: Record<string, unknown>,
) {
  return service.bind({
    conversation,
    targetSessionKey,
    targetKind: "session",
    placement: "current",
    metadata,
  });
}

function createManager(
  cfg: OpenClawConfig = baseCfg,
  accountId = "default",
): FeishuThreadBindingManager {
  const manager = createFeishuThreadBindingManagerImpl({ cfg, accountId });
  trackedManagers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of trackedManagers) {
    manager.stop();
  }
  trackedManagers.length = 0;
  vi.restoreAllMocks();
});

describe("Feishu thread bindings", () => {
  it("registers current-placement adapter capabilities for Feishu", () => {
    createManager();

    expect(service.getCapabilities(account)).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });
  });

  it("binds and resolves a Feishu topic conversation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    createManager({ ...baseCfg, agents: { entries: { main: {}, codex: {} } } });

    const conversation = conversationRef("oc_group_chat:topic:om_topic_root", "oc_group_chat");
    const binding = await bindTo(conversation, "agent:codex:acp:binding:feishu:default:abc123", {
      label: "codex-main",
    });
    expect(binding.conversation.conversationId).toBe(conversation.conversationId);
    const resolved = service.resolveByConversation(conversationRef(conversation.conversationId));
    expect(resolved).toEqual({
      bindingId: "default:oc_group_chat:topic:om_topic_root",
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: 1_700_000_000_000,
      expiresAt: 1_700_086_400_000,
      metadata: {
        agentId: "codex",
        label: "codex-main",
        boundBy: undefined,
        deliveryTo: undefined,
        deliveryThreadId: undefined,
        lastActivityAt: 1_700_000_000_000,
        idleTimeoutMs: 86_400_000,
        maxAgeMs: 0,
      },
    });
  });

  it.each([
    ["idle deadline", 86_400_000, undefined],
    ["maximum age after activity", 3_600_000, { idleHours: 2, maxAgeHours: 1 }],
    ["touch after expiry", 86_400_000, undefined],
  ] as const)("expires bindings at %s", async (mode, lifetime, threadBindings) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager({
      ...baseCfg,
      session: { ...baseCfg.session, threadBindings },
    });
    const targetSessionKey = "agent:codex:acp:binding:feishu:default:expired";
    const conversation = conversationRef("oc_group_chat:topic:om_expired_root");
    const binding = await bindTo(conversation, targetSessionKey);
    await bindTo(conversationRef("oc_group_chat:topic:om_expired_list_root"), targetSessionKey);
    const expiresAt = startedAt + lifetime;
    expect(binding.expiresAt).toBe(expiresAt);

    if (mode === "maximum age after activity") {
      now.mockReturnValue(startedAt + 30 * 60_000);
      service.touch(binding.bindingId);
      expect(service.resolveByConversation(conversation)?.expiresAt).toBe(expiresAt);
    }
    now.mockReturnValue(expiresAt - 1);
    expect(manager.getByConversationId(conversation.conversationId)).toBeDefined();
    expect(manager.listBySessionKey(targetSessionKey)).toHaveLength(2);
    expect(service.resolveByConversation(conversation)).not.toBeNull();
    expect(service.listBySession(targetSessionKey)).toHaveLength(2);

    now.mockReturnValue(expiresAt);
    if (mode === "touch after expiry") {
      service.touch(binding.bindingId, expiresAt + 1);
    }
    expect(service.resolveByConversation(conversation)).toBeNull();
    expect(manager.getByConversationId(conversation.conversationId)).toBeUndefined();
    expect(manager.listBySessionKey(targetSessionKey)).toEqual([]);
    expect(service.listBySession(targetSessionKey)).toEqual([]);
  });

  it("keeps active bindings touchable and unbindable", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    createManager();
    const conversation = conversationRef("oc_group_chat:topic:om_active_root");
    const binding = await bindTo(conversation, "agent:codex:acp:binding:feishu:default:active");

    now.mockReturnValue(startedAt + 1_000);
    service.touch(binding.bindingId);
    expect(service.resolveByConversation(conversation)?.metadata?.lastActivityAt).toBe(
      startedAt + 1_000,
    );

    await expect(service.unbind({ bindingId: binding.bindingId, reason: "test" })).resolves.toEqual(
      [expect.objectContaining({ bindingId: binding.bindingId })],
    );
    expect(service.resolveByConversation(conversation)).toBeNull();
  });

  it("keeps the account's binding adapter live when a stopped overlapping manager tears down", async () => {
    const previous = createManager();
    const replacement = createManager();

    const conversation = conversationRef("oc_group_chat:topic:om_overlap");
    const targetSessionKey = "agent:codex:acp:overlap";
    const input = { conversation, targetSessionKey, targetKind: "session" as const };
    await expect(service.bind(input)).resolves.toMatchObject({ conversation });

    previous.stop();

    expect(service.getCapabilities(account)).toMatchObject({ adapterAvailable: true });
    await expect(service.bind(input)).resolves.toMatchObject({ conversation });
    expect(getFeishuThreadBindingManager("default")).toBe(replacement);
  });

  it("clears account-scoped bindings when the manager stops", async () => {
    const manager = createManager();
    const original = conversationRef("oc_group_chat:topic:om_topic_root", "oc_group_chat");

    await bindTo(original, "agent:codex:acp:binding:feishu:default:abc123", {
      agentId: "codex",
    });

    manager.stop();

    expect(service.resolveByConversation(conversationRef(original.conversationId))).toBeNull();

    createManager();
    const conversation = conversationRef("oc_group_chat:topic:om_restarted");
    const replacement = await service.bind({
      conversation,
      targetSessionKey: "agent:codex:acp:replacement",
      targetKind: "session",
    });

    manager.stop();

    createManager();
    expect(service.resolveByConversation(conversation)).toEqual(replacement);
  });

  it.each(["refresh", "session", "kind"] as const)(
    "preserves conversation delivery fields without inheriting another target's owner (%s)",
    async (change) => {
      const replace = change !== "refresh";
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_100_000);
      const manager = createManager();
      const conversationId = "oc_group_chat:topic:om_topic_root:sender:ou_sender_1";
      const conversation = conversationRef(conversationId, "oc_group_chat");
      const targetSessionKey =
        change === "session" ? "agent:main:subagent:replacement" : "agent:main:subagent:child";
      const targetKind = change === "kind" ? "session" : "subagent";
      const pluginMetadata = {
        pluginBindingOwner: "plugin",
        pluginId: "fixture-plugin",
        pluginRoot: "/fixture/plugin",
        data: { threadId: "plugin-thread" },
      };

      manager.bindConversation({
        conversationId: conversation.conversationId,
        parentConversationId: conversation.parentConversationId,
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child",
        metadata: {
          agentId: "previous-agent",
          label: "child",
          boundBy: "ou_sender_1",
          deliveryTo: "user:ou_sender_1",
          deliveryThreadId: "om_topic_root",
          ...pluginMetadata,
        },
      });

      await service.bind({
        targetSessionKey,
        targetKind,
        conversation,
        placement: "current",
        metadata: { label: "child" },
      });

      expect(service.resolveByConversation(conversationRef(conversationId))).toEqual({
        bindingId: `default:${conversationId}`,
        targetSessionKey,
        targetKind,
        conversation,
        status: "active",
        boundAt: 1_700_000_100_000,
        expiresAt: 1_700_086_500_000,
        metadata: {
          ...(!replace ? pluginMetadata : {}),
          agentId: replace ? "main" : "previous-agent",
          label: "child",
          boundBy: replace ? undefined : "ou_sender_1",
          deliveryTo: "user:ou_sender_1",
          deliveryThreadId: "om_topic_root",
          lastActivityAt: 1_700_000_100_000,
          idleTimeoutMs: 86_400_000,
          maxAgeMs: 0,
        },
      });
    },
  );
});

function origin(to: string, threadId?: string) {
  return { channel: "feishu" as const, accountId: "work", to, ...(threadId ? { threadId } : {}) };
}

type FeishuOrigin = ReturnType<typeof origin>;
const child = "agent:main:subagent:child";

function deliveryEvent(params: {
  childSessionKey: string;
  requesterOrigin?: FeishuOrigin;
  requesterSessionKey?: string;
}) {
  return {
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey ?? "agent:main:main",
    requesterOrigin: params.requesterOrigin ?? origin("user:ou_sender_1"),
    expectsCompletionMessage: true,
  };
}

function managedHookFixture() {
  const handlers = registerHookHandlersForTest<OpenClawPluginApi>({
    config: { ...baseCfg, channels: { feishu: {} } },
    register: registerFeishuSubagentHooks,
  });
  const manager = createManager({ ...baseCfg, channels: { feishu: {} } }, "work");
  const deliveryHandler = getRequiredHookHandler(handlers, "subagent_delivery_target");
  return {
    deliveryHandler,
    deliver: (
      childSessionKey: string,
      requesterOrigin?: FeishuOrigin,
      requesterSessionKey?: string,
    ) =>
      deliveryHandler(deliveryEvent({ childSessionKey, requesterOrigin, requesterSessionKey }), {}),
    endedHandler: getRequiredHookHandler(handlers, "subagent_ended"),
    manager,
    bind: (
      conversationId: string,
      params: Partial<Parameters<typeof manager.bindConversation>[0]> = {},
    ) =>
      manager.bindConversation({
        conversationId,
        targetKind: "subagent",
        targetSessionKey: child,
        ...params,
      }),
  };
}

describe("feishu subagent hook handlers", () => {
  it.each([
    { conversationId: "ou_sender_1", chat: "oc_dm" },
    { conversationId: "oc_group:topic:om_root", chat: "oc_group", thread: "om_root" },
  ])("preserves bound delivery for $conversationId", async ({ conversationId, chat, thread }) => {
    const { deliver, bind } = managedHookFixture();
    const to = `chat:${chat}`;
    bind(conversationId, {
      parentConversationId: thread ? chat : undefined,
      metadata: { deliveryTo: to, deliveryThreadId: thread, boundBy: "system" },
    });
    await expect(deliver(child, origin(to, thread))).resolves.toEqual({
      origin: origin(to, thread),
    });
  });

  it("selects the requester-matching binding when a child has multiple routes", async () => {
    const { deliver, bind } = managedHookFixture();
    for (const sender of ["ou_sender_1", "ou_sender_2"]) {
      bind(sender, {
        metadata: { deliveryTo: `user:${sender}`, boundBy: "system" },
      });
    }

    await expect(deliver(child, origin("user:ou_sender_2"))).resolves.toEqual({
      origin: origin("user:ou_sender_2"),
    });
  });

  it.each(["single", "direct", "topic"] as const)(
    "keeps the selected %s requester record private and unchanged",
    async (selection) => {
      const { deliver, bind, manager } = managedHookFixture();
      // One account/conversation has one record, so matching requester and child routes share a session.
      const topic = selection === "topic";
      if (selection !== "single") {
        bind("ou_other", {
          metadata: { deliveryTo: "user:ou_other" },
        });
      }
      bind(topic ? "oc_group:topic:om_topic:sender:ou_selected" : "ou_selected", {
        parentConversationId: topic ? "oc_group" : undefined,
        metadata: {
          deliveryTo: " chat:oc_delivery ",
          ...(topic ? { deliveryThreadId: " om_delivery " } : {}),
          label: "private route label",
          boundBy: "fixture",
          data: { internal: "not an origin field" },
        },
      });
      const records = manager.listBySessionKey(child);
      const snapshot = structuredClone(records);
      expect(records).toHaveLength(selection === "single" ? 1 : 2);

      await expect(
        deliver(
          child,
          topic
            ? origin("chat:oc_group", "om_topic")
            : origin(selection === "single" ? "user:ou_unrelated" : "user:ou_selected"),
          ` ${child} `,
        ),
      ).resolves.toStrictEqual({
        origin: origin("chat:oc_delivery", topic ? "om_delivery" : undefined),
      });
      expect(manager.listBySessionKey(child)).toStrictEqual(snapshot);
      for (const record of records) {
        expect(manager.getByConversationId(record.conversationId)).toBe(record);
      }
    },
  );

  it.each(["direct", "topic"] as const)(
    "does not pick one of several child routes when the requester has no %s match",
    async (selection) => {
      const { deliver, bind } = managedHookFixture();
      for (const sender of ["ou_one", "ou_two"]) {
        bind(sender);
      }

      await expect(
        deliver(
          child,
          selection === "topic" ? origin("chat:oc_group", "om_missing") : origin("user:ou_missing"),
          child,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("keeps ambiguous requester topics unresolved unless the child has one route", async () => {
    const { deliveryHandler, bind, manager } = managedHookFixture();
    const requesterSessionKey = "agent:main:requester";
    for (const sender of ["ou_a", "ou_b"]) {
      bind(`oc_group:topic:om_topic:sender:${sender}`, {
        parentConversationId: "oc_group",
        targetKind: "session",
        targetSessionKey: requesterSessionKey,
      });
    }
    for (const [chat, topic] of [
      ["oc_group", "om_topic"],
      ["oc_other", "om_other"],
    ] as const) {
      bind(`${chat}:topic:${topic}`, {
        parentConversationId: chat,
      });
    }
    const event = deliveryEvent({
      childSessionKey: child,
      requesterSessionKey,
      requesterOrigin: origin("chat:oc_group", "om_topic"),
    });

    await expect(deliveryHandler(event, {})).resolves.toBeUndefined();

    manager.unbindConversation("oc_other:topic:om_other");
    await expect(deliveryHandler(event, {})).resolves.toEqual({
      origin: origin("chat:oc_group", "om_topic"),
    });
  });

  it("removes bound routes on subagent_ended", async () => {
    const { deliver, endedHandler, bind } = managedHookFixture();
    bind("ou_sender_1", {
      metadata: { deliveryTo: "user:ou_sender_1", boundBy: "system" },
    });

    await endedHandler(
      {
        targetSessionKey: child,
        targetKind: "subagent",
        reason: "done",
        accountId: "work",
      },
      {},
    );

    await expect(deliver(child)).resolves.toBeUndefined();
  });

  it("leaves disabled completion, unrelated channels and missing managers unchanged", async () => {
    const { deliveryHandler, manager, bind } = managedHookFixture();
    bind("ou_sender_1");
    const event = deliveryEvent({ childSessionKey: child });

    await expect(
      deliveryHandler({ ...event, expectsCompletionMessage: false }, {}),
    ).resolves.toBeUndefined();
    await expect(
      deliveryHandler(
        { ...event, requesterOrigin: { channel: "discord", accountId: "work", to: "channel:123" } },
        {},
      ),
    ).resolves.toBeUndefined();
    manager.stop();
    await expect(deliveryHandler(event, {})).resolves.toBeUndefined();
  });
});
