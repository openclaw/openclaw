import { resolveThreadBindingConversationIdFromBindingId } from "openclaw/plugin-sdk/channel-runtime";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/text-runtime";

const FEISHU_THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;

type FeishuBindingTargetKind = "subagent" | "acp";

type FeishuThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  deliveryTo?: string;
  deliveryThreadId?: string;
  targetKind: FeishuBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

type FeishuThreadBindingManager = {
  accountId: string;
  getByConversationId: (conversationId: string) => FeishuThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  bindConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => FeishuThreadBindingRecord | null;
  touchConversation: (conversationId: string, at?: number) => FeishuThreadBindingRecord | null;
  unbindConversation: (conversationId: string) => FeishuThreadBindingRecord | null;
  unbindBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  stop: () => void;
};

type FeishuThreadBindingsState = {
  managersByAccountId: Map<string, FeishuThreadBindingManager>;
  bindingsByAccountConversation: Map<string, FeishuThreadBindingRecord>;
};

const FEISHU_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.feishuThreadBindingsState");
const state = resolveGlobalSingleton<FeishuThreadBindingsState>(
  FEISHU_THREAD_BINDINGS_STATE_KEY,
  () => ({
    managersByAccountId: new Map(),
    bindingsByAccountConversation: new Map(),
  }),
);

const MANAGERS_BY_ACCOUNT_ID = state.managersByAccountId;
const BINDINGS_BY_ACCOUNT_CONVERSATION = state.bindingsByAccountConversation;

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: FeishuBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toFeishuTargetKind(raw: BindingTargetKind): FeishuBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function toSessionBindingRecord(
  record: FeishuThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const effectiveIdleMs =
    typeof record.idleTimeoutMs === "number" && Number.isFinite(record.idleTimeoutMs)
      ? record.idleTimeoutMs
      : defaults.idleTimeoutMs;
  const effectiveMaxAgeMs =
    typeof record.maxAgeMs === "number" && Number.isFinite(record.maxAgeMs)
      ? record.maxAgeMs
      : defaults.maxAgeMs;
  const idleExpiresAt = effectiveIdleMs > 0 ? record.lastActivityAt + effectiveIdleMs : undefined;
  const maxAgeExpiresAt = effectiveMaxAgeMs > 0 ? record.boundAt + effectiveMaxAgeMs : undefined;
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
      channel: "feishu",
      accountId: record.accountId,
      conversationId: record.conversationId,
      parentConversationId: record.parentConversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt,
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      deliveryTo: record.deliveryTo,
      deliveryThreadId: record.deliveryThreadId,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: effectiveIdleMs,
      maxAgeMs: effectiveMaxAgeMs,
    },
  };
}

function shouldExpireByIdle(params: {
  now: number;
  record: FeishuThreadBindingRecord;
  defaultIdleTimeoutMs: number;
}): boolean {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  if (idleTimeoutMs <= 0) {
    return false;
  }
  return (
    params.now >= Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
  );
}

function shouldExpireByMaxAge(params: {
  now: number;
  record: FeishuThreadBindingRecord;
  defaultMaxAgeMs: number;
}): boolean {
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;
  if (maxAgeMs <= 0) {
    return false;
  }
  return params.now >= params.record.boundAt + maxAgeMs;
}

export function createFeishuThreadBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
  enableSweeper?: boolean;
}): FeishuThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    return existing;
  }

  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg: params.cfg,
    channel: "feishu",
    accountId,
  });
  const maxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg: params.cfg,
    channel: "feishu",
    accountId,
  });

  const listBindingsForAccount = () =>
    [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter((entry) => entry.accountId === accountId);

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: FeishuThreadBindingManager = {
    accountId,
    getByConversationId: (conversationId) =>
      BINDINGS_BY_ACCOUNT_CONVERSATION.get(resolveBindingKey({ accountId, conversationId })),
    listBySessionKey: (targetSessionKey) =>
      [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter(
        (record) => record.accountId === accountId && record.targetSessionKey === targetSessionKey,
      ),
    bindConversation: ({
      conversationId,
      parentConversationId,
      targetKind,
      targetSessionKey,
      metadata,
    }) => {
      const normalizedConversationId = conversationId.trim();
      if (!normalizedConversationId || !targetSessionKey.trim()) {
        return null;
      }
      const now = Date.now();
      const record: FeishuThreadBindingRecord = {
        accountId,
        conversationId: normalizedConversationId,
        parentConversationId: parentConversationId?.trim() || undefined,
        deliveryTo:
          typeof metadata?.deliveryTo === "string" && metadata.deliveryTo.trim()
            ? metadata.deliveryTo.trim()
            : undefined,
        deliveryThreadId:
          typeof metadata?.deliveryThreadId === "string" && metadata.deliveryThreadId.trim()
            ? metadata.deliveryThreadId.trim()
            : undefined,
        targetKind: toFeishuTargetKind(targetKind),
        targetSessionKey: targetSessionKey.trim(),
        agentId:
          typeof metadata?.agentId === "string" && metadata.agentId.trim()
            ? metadata.agentId.trim()
            : resolveAgentIdFromSessionKey(targetSessionKey),
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
      BINDINGS_BY_ACCOUNT_CONVERSATION.set(
        resolveBindingKey({ accountId, conversationId: normalizedConversationId }),
        record,
      );
      return record;
    },
    touchConversation: (conversationId, at = Date.now()) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key);
      if (!existingRecord) {
        return null;
      }
      const updated = { ...existingRecord, lastActivityAt: at };
      BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, updated);
      return updated;
    },
    unbindConversation: (conversationId) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key);
      if (!existingRecord) {
        return null;
      }
      BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
      return existingRecord;
    },
    unbindBySessionKey: (targetSessionKey) => {
      const removed: FeishuThreadBindingRecord[] = [];
      for (const record of [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()]) {
        if (record.accountId !== accountId || record.targetSessionKey !== targetSessionKey) {
          continue;
        }
        BINDINGS_BY_ACCOUNT_CONVERSATION.delete(
          resolveBindingKey({ accountId, conversationId: record.conversationId }),
        );
        removed.push(record);
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      for (const key of [...BINDINGS_BY_ACCOUNT_CONVERSATION.keys()]) {
        if (key.startsWith(`${accountId}:`)) {
          BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
        }
      }
      unregisterSessionBindingAdapter({ channel: "feishu", accountId });
      const existingManager = MANAGERS_BY_ACCOUNT_ID.get(accountId);
      if (existingManager === manager) {
        MANAGERS_BY_ACCOUNT_ID.delete(accountId);
      }
    },
  };

  registerSessionBindingAdapter({
    channel: "feishu",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "feishu" || input.placement === "child") {
        return null;
      }
      const bound = manager.bindConversation({
        conversationId: input.conversation.conversationId,
        parentConversationId: input.conversation.parentConversationId,
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
      if (ref.channel !== "feishu") {
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
  });

  const sweeperEnabled = params.enableSweeper !== false;
  if (sweeperEnabled) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const record of listBindingsForAccount()) {
        const idleExpired = shouldExpireByIdle({
          now,
          record,
          defaultIdleTimeoutMs: idleTimeoutMs,
        });
        const maxAgeExpired = shouldExpireByMaxAge({
          now,
          record,
          defaultMaxAgeMs: maxAgeMs,
        });
        if (!idleExpired && !maxAgeExpired) {
          continue;
        }
        manager.unbindConversation(record.conversationId);
      }
    }, FEISHU_THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  MANAGERS_BY_ACCOUNT_ID.set(accountId, manager);
  return manager;
}

export function getFeishuThreadBindingManager(
  accountId?: string,
): FeishuThreadBindingManager | null {
  return MANAGERS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId)) ?? null;
}

function normalizeDurationMs(raw: number, fallback: number): number {
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

export function setFeishuThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): FeishuThreadBindingRecord[] {
  const manager = getFeishuThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const idleTimeoutMs = normalizeDurationMs(params.idleTimeoutMs, 0);
  const now = Date.now();
  const updated: FeishuThreadBindingRecord[] = [];
  const entries = manager.listBySessionKey(params.targetSessionKey.trim());
  for (const entry of entries) {
    const key = resolveBindingKey({
      accountId: manager.accountId,
      conversationId: entry.conversationId,
    });
    const next = { ...entry, idleTimeoutMs, lastActivityAt: now };
    BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, next);
    updated.push(next);
  }
  return updated;
}

export function setFeishuThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): FeishuThreadBindingRecord[] {
  const manager = getFeishuThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, 0);
  const now = Date.now();
  const updated: FeishuThreadBindingRecord[] = [];
  const entries = manager.listBySessionKey(params.targetSessionKey.trim());
  for (const entry of entries) {
    const key = resolveBindingKey({
      accountId: manager.accountId,
      conversationId: entry.conversationId,
    });
    const next = { ...entry, maxAgeMs, lastActivityAt: now };
    BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, next);
    updated.push(next);
  }
  return updated;
}

export const __testing = {
  resetFeishuThreadBindingsForTests() {
    for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
      manager.stop();
    }
    MANAGERS_BY_ACCOUNT_ID.clear();
    BINDINGS_BY_ACCOUNT_CONVERSATION.clear();
  },
};
