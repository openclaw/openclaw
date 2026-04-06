import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";

type IMessageBindingTargetKind = "subagent" | "acp";

type IMessageConversationBindingRecord = {
  accountId: string;
  conversationId: string;
  targetKind: IMessageBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
};

type IMessageConversationBindingManager = {
  accountId: string;
  getByConversationId: (conversationId: string) => IMessageConversationBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => IMessageConversationBindingRecord[];
  bindConversation: (params: {
    conversationId: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => IMessageConversationBindingRecord | null;
  touchConversation: (
    conversationId: string,
    at?: number,
  ) => IMessageConversationBindingRecord | null;
  unbindConversation: (conversationId: string) => IMessageConversationBindingRecord | null;
  unbindBySessionKey: (targetSessionKey: string) => IMessageConversationBindingRecord[];
  stop: () => void;
};

type IMessageConversationBindingsState = {
  managersByAccountId: Map<string, IMessageConversationBindingManager>;
  bindingsByAccountConversation: Map<string, IMessageConversationBindingRecord>;
};

const IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY = Symbol.for(
  "openclaw.imessageConversationBindingsState",
);
let state: IMessageConversationBindingsState | undefined;

function getState(): IMessageConversationBindingsState {
  if (!state) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    state = (globalStore[IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY] as
      | IMessageConversationBindingsState
      | undefined) ?? {
      managersByAccountId: new Map(),
      bindingsByAccountConversation: new Map(),
    };
    globalStore[IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY] = state;
  }
  return state;
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: IMessageBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toIMessageTargetKind(raw: BindingTargetKind): IMessageBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function toSessionBindingRecord(
  record: IMessageConversationBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const idleExpiresAt =
    defaults.idleTimeoutMs > 0 ? record.lastActivityAt + defaults.idleTimeoutMs : undefined;
  const maxAgeExpiresAt = defaults.maxAgeMs > 0 ? record.boundAt + defaults.maxAgeMs : undefined;
  const expiresAt =
    idleExpiresAt != null && maxAgeExpiresAt != null
      ? Math.min(idleExpiresAt, maxAgeExpiresAt)
      : (idleExpiresAt ?? maxAgeExpiresAt);
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "imessage",
      accountId: record.accountId,
      conversationId: record.conversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt,
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: defaults.idleTimeoutMs,
      maxAgeMs: defaults.maxAgeMs,
    },
  };
}

export function createIMessageConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): IMessageConversationBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = getState().managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg: params.cfg,
    channel: "imessage",
    accountId,
  });
  const maxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg: params.cfg,
    channel: "imessage",
    accountId,
  });

  const manager: IMessageConversationBindingManager = {
    accountId,
    getByConversationId: (conversationId) =>
      getState().bindingsByAccountConversation.get(
        resolveBindingKey({ accountId, conversationId }),
      ),
    listBySessionKey: (targetSessionKey) =>
      [...getState().bindingsByAccountConversation.values()].filter(
        (record) => record.accountId === accountId && record.targetSessionKey === targetSessionKey,
      ),
    bindConversation: ({ conversationId, targetKind, targetSessionKey, metadata }) => {
      const normalizedConversationId = conversationId.trim();
      const normalizedTargetSessionKey = targetSessionKey.trim();
      if (!normalizedConversationId || !normalizedTargetSessionKey) {
        return null;
      }
      const now = Date.now();
      const record: IMessageConversationBindingRecord = {
        accountId,
        conversationId: normalizedConversationId,
        targetKind: toIMessageTargetKind(targetKind),
        targetSessionKey: normalizedTargetSessionKey,
        agentId:
          typeof metadata?.agentId === "string" && metadata.agentId.trim()
            ? metadata.agentId.trim()
            : resolveAgentIdFromSessionKey(normalizedTargetSessionKey),
        label:
          typeof metadata?.label === "string" && metadata.label.trim()
            ? metadata.label.trim()
            : undefined,
        boundBy:
          typeof metadata?.boundBy === "string" && metadata.boundBy.trim()
            ? metadata.boundBy.trim()
            : undefined,
        boundAt: now,
        lastActivityAt: now,
      };
      getState().bindingsByAccountConversation.set(
        resolveBindingKey({ accountId, conversationId: normalizedConversationId }),
        record,
      );
      return record;
    },
    touchConversation: (conversationId, at = Date.now()) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = getState().bindingsByAccountConversation.get(key);
      if (!existingRecord) {
        return null;
      }
      const updated = { ...existingRecord, lastActivityAt: at };
      getState().bindingsByAccountConversation.set(key, updated);
      return updated;
    },
    unbindConversation: (conversationId) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = getState().bindingsByAccountConversation.get(key);
      if (!existingRecord) {
        return null;
      }
      getState().bindingsByAccountConversation.delete(key);
      return existingRecord;
    },
    unbindBySessionKey: (targetSessionKey) => {
      const removed: IMessageConversationBindingRecord[] = [];
      for (const record of getState().bindingsByAccountConversation.values()) {
        if (record.accountId !== accountId || record.targetSessionKey !== targetSessionKey) {
          continue;
        }
        getState().bindingsByAccountConversation.delete(
          resolveBindingKey({ accountId, conversationId: record.conversationId }),
        );
        removed.push(record);
      }
      return removed;
    },
    stop: () => {
      for (const key of getState().bindingsByAccountConversation.keys()) {
        if (key.startsWith(`${accountId}:`)) {
          getState().bindingsByAccountConversation.delete(key);
        }
      }
      getState().managersByAccountId.delete(accountId);
      unregisterSessionBindingAdapter({
        channel: "imessage",
        accountId,
        adapter: sessionBindingAdapter,
      });
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "imessage",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "imessage" || input.placement === "child") {
        return null;
      }
      const bound = manager.bindConversation({
        conversationId: input.conversation.conversationId,
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
        metadata: input.metadata,
      });
      return bound ? toSessionBindingRecord(bound, { idleTimeoutMs, maxAgeMs }) : null;
    },
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs })),
    resolveByConversation: (ref) => {
      if (ref.channel !== "imessage") {
        return null;
      }
      const found = manager.getByConversationId(ref.conversationId);
      return found ? toSessionBindingRecord(found, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (conversationId) {
        manager.touchConversation(conversationId, at);
      }
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        return manager
          .unbindBySessionKey(input.targetSessionKey.trim())
          .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation(conversationId);
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);
  getState().managersByAccountId.set(accountId, manager);
  return manager;
}

export const __testing = {
  resetIMessageConversationBindingsForTests() {
    for (const manager of getState().managersByAccountId.values()) {
      manager.stop();
    }
    getState().managersByAccountId.clear();
    getState().bindingsByAccountConversation.clear();
  },
};
