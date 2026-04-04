import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import {
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-runtime";

type BlueBubblesBindingTargetKind = "subagent" | "acp";

type BlueBubblesConversationBindingRecord = {
  accountId: string;
  conversationId: string;
  targetKind: BlueBubblesBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
};

type BlueBubblesConversationBindingManager = {
  accountId: string;
  getByConversationId: (conversationId: string) => BlueBubblesConversationBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => BlueBubblesConversationBindingRecord[];
  bindConversation: (params: {
    conversationId: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => BlueBubblesConversationBindingRecord | null;
  touchConversation: (
    conversationId: string,
    at?: number,
  ) => BlueBubblesConversationBindingRecord | null;
  unbindConversation: (conversationId: string) => BlueBubblesConversationBindingRecord | null;
  unbindBySessionKey: (targetSessionKey: string) => BlueBubblesConversationBindingRecord[];
  stop: () => void;
};

type BlueBubblesConversationBindingsState = {
  managersByAccountId: Map<string, BlueBubblesConversationBindingManager>;
  bindingsByAccountConversation: Map<string, BlueBubblesConversationBindingRecord>;
};

const BLUEBUBBLES_CONVERSATION_BINDINGS_STATE_KEY = Symbol.for(
  "openclaw.bluebubblesConversationBindingsState",
);
let state: BlueBubblesConversationBindingsState | undefined;

function getState(): BlueBubblesConversationBindingsState {
  if (!state) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    state = (globalStore[BLUEBUBBLES_CONVERSATION_BINDINGS_STATE_KEY] as
      | BlueBubblesConversationBindingsState
      | undefined) ?? {
      managersByAccountId: new Map(),
      bindingsByAccountConversation: new Map(),
    };
    globalStore[BLUEBUBBLES_CONVERSATION_BINDINGS_STATE_KEY] = state;
  }
  return state;
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: BlueBubblesBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toBlueBubblesTargetKind(raw: BindingTargetKind): BlueBubblesBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function toSessionBindingRecord(
  record: BlueBubblesConversationBindingRecord,
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
      channel: "bluebubbles",
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

export function createBlueBubblesConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): BlueBubblesConversationBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = getState().managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg: params.cfg,
    channel: "bluebubbles",
    accountId,
  });
  const maxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg: params.cfg,
    channel: "bluebubbles",
    accountId,
  });

  const manager: BlueBubblesConversationBindingManager = {
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
      const record: BlueBubblesConversationBindingRecord = {
        accountId,
        conversationId: normalizedConversationId,
        targetKind: toBlueBubblesTargetKind(targetKind),
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
      const removed: BlueBubblesConversationBindingRecord[] = [];
      for (const record of [...getState().bindingsByAccountConversation.values()]) {
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
      for (const key of [...getState().bindingsByAccountConversation.keys()]) {
        if (key.startsWith(`${accountId}:`)) {
          getState().bindingsByAccountConversation.delete(key);
        }
      }
      getState().managersByAccountId.delete(accountId);
      unregisterSessionBindingAdapter({
        channel: "bluebubbles",
        accountId,
        adapter: sessionBindingAdapter,
      });
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "bluebubbles",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "bluebubbles" || input.placement === "child") {
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
      if (ref.channel !== "bluebubbles") {
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
  resetBlueBubblesConversationBindingsForTests() {
    for (const manager of getState().managersByAccountId.values()) {
      manager.stop();
    }
    getState().managersByAccountId.clear();
    getState().bindingsByAccountConversation.clear();
  },
};
