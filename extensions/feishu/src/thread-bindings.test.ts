import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function bind(conversation: ReturnType<typeof conversationRef>, targetSessionKey: string) {
  return service.bind({
    conversation,
    targetSessionKey,
    targetKind: "session",
    placement: "current",
  });
}

function createManager(cfg: OpenClawConfig = baseCfg): FeishuThreadBindingManager {
  const manager = createFeishuThreadBindingManagerImpl({ cfg, accountId: "default" });
  trackedManagers.push(manager);
  return manager;
}

describe("Feishu thread bindings", () => {
  afterEach(() => {
    for (const manager of trackedManagers) {
      manager.stop();
    }
    trackedManagers.length = 0;
    vi.restoreAllMocks();
  });

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

    const binding = await getSessionBindingService().bind({
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
        parentConversationId: "oc_group_chat",
      },
      placement: "current",
      metadata: {
        label: "codex-main",
      },
    });

    expect(binding.conversation.conversationId).toBe("oc_group_chat:topic:om_topic_root");
    const resolved = getSessionBindingService().resolveByConversation({
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_topic_root",
    });
    expect(resolved).toEqual({
      bindingId: "default:oc_group_chat:topic:om_topic_root",
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
        parentConversationId: "oc_group_chat",
      },
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

  it("expires idle bindings from manager and service lookups at the deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager();
    const targetSessionKey = "agent:codex:acp:binding:feishu:default:expired";
    const conversation = {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_expired_root",
    };

    const binding = await service.bind({
      targetSessionKey,
      targetKind: "session",
      conversation,
      placement: "current",
    });
    await service.bind({
      targetSessionKey,
      targetKind: "session",
      conversation: {
        ...conversation,
        conversationId: "oc_group_chat:topic:om_expired_list_root",
      },
      placement: "current",
    });
    const expiresAt = startedAt + 86_400_000;
    expect(binding.expiresAt).toBe(expiresAt);

    now.mockReturnValue(expiresAt - 1);
    expect(manager.getByConversationId(conversation.conversationId)).toBeDefined();
    expect(manager.listBySessionKey(targetSessionKey)).toHaveLength(2);
    expect(service.resolveByConversation(conversation)).not.toBeNull();
    expect(service.listBySession(targetSessionKey)).toHaveLength(2);

    now.mockReturnValue(expiresAt);
    expect(service.resolveByConversation(conversation)).toBeNull();
    expect(manager.getByConversationId(conversation.conversationId)).toBeUndefined();
    expect(manager.listBySessionKey(targetSessionKey)).toEqual([]);
    expect(service.listBySession(targetSessionKey)).toEqual([]);
  });

  it("expires bindings at their maximum age even after activity refreshes idle time", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    createManager({
      session: { ...baseCfg.session, threadBindings: { idleHours: 2, maxAgeHours: 1 } },
    });
    const conversation = conversationRef("oc_group_chat:topic:om_max_age_root");
    const binding = await bind(conversation, "agent:codex:acp:binding:feishu:default:max-age");

    now.mockReturnValue(startedAt + 30 * 60_000);
    service.touch(binding.bindingId);
    expect(service.resolveByConversation(conversation)?.expiresAt).toBe(startedAt + 60 * 60_000);

    now.mockReturnValue(startedAt + 60 * 60_000);
    expect(service.resolveByConversation(conversation)).toBeNull();
    expect(service.listBySession(binding.targetSessionKey)).toEqual([]);
  });

  it("does not revive an expired binding when its conversation is touched", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const manager = createManager();
    const conversation = conversationRef("oc_group_chat:topic:om_expired_touch_root");
    const binding = await bind(
      conversation,
      "agent:codex:acp:binding:feishu:default:expired-touch",
    );
    const expiresAt = startedAt + 86_400_000;
    expect(binding.expiresAt).toBe(expiresAt);

    now.mockReturnValue(expiresAt);
    service.touch(binding.bindingId, expiresAt + 1);

    expect(manager.getByConversationId(conversation.conversationId)).toBeUndefined();
    expect(service.resolveByConversation(conversation)).toBeNull();
  });

  it("keeps active bindings touchable and unbindable", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    createManager();
    const conversation = {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_active_root",
    };
    const binding = await service.bind({
      targetSessionKey: "agent:codex:acp:binding:feishu:default:active",
      targetKind: "session",
      conversation,
      placement: "current",
    });

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

    await service.bind({
      targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      targetKind: "session",
      conversation: original,
      placement: "current",
      metadata: { agentId: "codex" },
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
