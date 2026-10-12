import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isPluginOwnedSessionBindingRecord } from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AccountScopedConversationBindingRecord } from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import {
  createAccountScopedBindingAdapterV2,
  projectThreadBindingRecord,
  registerSessionBindingAdapterV2,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";

type FeishuBindingTargetKind = "subagent" | "acp";

type FeishuThreadBindingRecord = AccountScopedConversationBindingRecord<FeishuBindingTargetKind> & {
  parentConversationId?: string;
  deliveryTo?: string;
  deliveryThreadId?: string;
  metadata?: Record<string, unknown>;
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
let state: FeishuThreadBindingsState | undefined;

function getState(): FeishuThreadBindingsState {
  return (state ??= resolveGlobalSingleton(FEISHU_THREAD_BINDINGS_STATE_KEY, () => ({
    managersByAccountId: new Map(),
    bindingsByAccountConversation: new Map(),
  })));
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingRecord(
  record: FeishuThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const idleExpiresAt =
    defaults.idleTimeoutMs > 0 ? record.lastActivityAt + defaults.idleTimeoutMs : undefined;
  const maxAgeExpiresAt = defaults.maxAgeMs > 0 ? record.boundAt + defaults.maxAgeMs : undefined;
  const expiresAt =
    idleExpiresAt != null && maxAgeExpiresAt != null
      ? Math.min(idleExpiresAt, maxAgeExpiresAt)
      : (idleExpiresAt ?? maxAgeExpiresAt);
  return projectThreadBindingRecord(record, {
    conversation: {
      channel: "feishu",
      conversationId: record.conversationId,
      parentConversationId: record.parentConversationId,
    },
    targetKind: record.targetKind === "subagent" ? "subagent" : "session",
    lifecycle: { ...defaults, expiresAt },
    metadata: (lifecycleMetadata) => ({
      ...record.metadata,
      ...lifecycleMetadata,
      deliveryTo: record.deliveryTo,
      deliveryThreadId: record.deliveryThreadId,
    }),
  });
}

export function createFeishuThreadBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): FeishuThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const { managersByAccountId, bindingsByAccountConversation } = getState();
  const existing = managersByAccountId.get(accountId);
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
  const bindingTimeouts = { idleTimeoutMs, maxAgeMs };

  const resolveActiveBinding = (
    record: FeishuThreadBindingRecord | undefined,
    now = Date.now(),
  ): FeishuThreadBindingRecord | undefined => {
    if (!record) {
      return undefined;
    }
    const { expiresAt } = toSessionBindingRecord(record, bindingTimeouts);
    if (expiresAt === undefined || isFutureDateTimestampMs(expiresAt, { nowMs: now })) {
      return record;
    }

    // Expire at the manager boundary so direct subagent reads and SDK adapters agree.
    bindingsByAccountConversation.delete(
      resolveBindingKey({ accountId, conversationId: record.conversationId }),
    );
    return undefined;
  };

  const manager: FeishuThreadBindingManager = {
    accountId,
    getByConversationId: (conversationId) =>
      resolveActiveBinding(
        bindingsByAccountConversation.get(resolveBindingKey({ accountId, conversationId })),
      ),
    listBySessionKey: (targetSessionKey) => {
      const now = Date.now();
      return [...bindingsByAccountConversation.values()].filter(
        (record) =>
          record.accountId === accountId &&
          record.targetSessionKey === targetSessionKey &&
          resolveActiveBinding(record, now) !== undefined,
      );
    },
    bindConversation: ({
      conversationId,
      parentConversationId,
      targetKind,
      targetSessionKey,
      metadata,
    }) => {
      const normalizedConversationId = conversationId.trim();
      const normalizedTargetSessionKey = targetSessionKey.trim();
      if (!normalizedConversationId || !normalizedTargetSessionKey) {
        return null;
      }
      const existingLocal = manager.getByConversationId(normalizedConversationId);
      const storedTargetKind = targetKind === "subagent" ? "subagent" : "acp";
      const previous =
        existingLocal?.targetSessionKey === normalizedTargetSessionKey &&
        existingLocal.targetKind === storedTargetKind
          ? existingLocal
          : undefined;
      // A plugin's opaque target has no agent owner, including on metadata-omitting refreshes.
      const targetMetadata = { ...previous?.metadata, ...metadata };
      const now = Date.now();
      const record: FeishuThreadBindingRecord = {
        accountId,
        conversationId: normalizedConversationId,
        parentConversationId:
          normalizeOptionalString(parentConversationId) ?? existingLocal?.parentConversationId,
        deliveryTo: normalizeOptionalString(metadata?.deliveryTo) ?? existingLocal?.deliveryTo,
        deliveryThreadId:
          normalizeOptionalString(metadata?.deliveryThreadId) ?? existingLocal?.deliveryThreadId,
        targetKind: storedTargetKind,
        targetSessionKey: normalizedTargetSessionKey,
        agentId:
          normalizeOptionalString(metadata?.agentId) ??
          previous?.agentId ??
          (isPluginOwnedSessionBindingRecord({ metadata: targetMetadata })
            ? undefined
            : resolveSessionAgentIdStrict({
                config: params.cfg,
                sessionKey: normalizedTargetSessionKey,
              })),
        label: normalizeOptionalString(metadata?.label) ?? previous?.label,
        boundBy: normalizeOptionalString(metadata?.boundBy) ?? previous?.boundBy,
        boundAt: now,
        lastActivityAt: now,
        metadata: targetMetadata,
      };
      bindingsByAccountConversation.set(resolveBindingKey(record), record);
      return record;
    },
    touchConversation: (conversationId, at = Date.now()) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = manager.getByConversationId(conversationId);
      if (!existingRecord) {
        return null;
      }
      const updated = { ...existingRecord, lastActivityAt: at };
      bindingsByAccountConversation.set(key, updated);
      return updated;
    },
    unbindConversation: (conversationId) => {
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = bindingsByAccountConversation.get(key);
      if (!existingRecord) {
        return null;
      }
      bindingsByAccountConversation.delete(key);
      return existingRecord;
    },
    unbindBySessionKey: (targetSessionKey) => {
      const removed: FeishuThreadBindingRecord[] = [];
      for (const record of bindingsByAccountConversation.values()) {
        if (record.accountId !== accountId || record.targetSessionKey !== targetSessionKey) {
          continue;
        }
        bindingsByAccountConversation.delete(resolveBindingKey(record));
        removed.push(record);
      }
      return removed;
    },
    stop: () => {
      // A repeated shutdown must not remove a replacement manager's live bindings.
      if (managersByAccountId.get(accountId) === manager) {
        for (const key of bindingsByAccountConversation.keys()) {
          if (key.startsWith(`${accountId}:`)) {
            bindingsByAccountConversation.delete(key);
          }
        }
        managersByAccountId.delete(accountId);
      }
      unregisterSessionBindingAdapter({
        channel: "feishu",
        accountId,
        adapter: sessionBindingAdapter,
      });
    },
  };

  const assertCurrent = () => {
    if (managersByAccountId.get(accountId) !== manager) {
      throw new Error("Feishu conversation binding owner is no longer active");
    }
  };
  const sessionBindingAdapter = createAccountScopedBindingAdapterV2({
    assertCurrent,
    inspectByConversations: (refs) => {
      const records = refs.map((ref) => manager.getByConversationId(ref.conversationId));
      return {
        records,
        assertCurrent: () => {
          assertCurrent();
          if (
            refs.some(
              (ref, index) => manager.getByConversationId(ref.conversationId) !== records[index],
            )
          ) {
            throw new Error("Feishu conversation binding changed during selection");
          }
        },
      };
    },
    listBySessionKeyAsync: async (sessionKey) => manager.listBySessionKey(sessionKey),
    getByConversationAsync: async (ref) => manager.getByConversationId(ref.conversationId),
    inspectByConversationAsync: async (ref) => manager.getByConversationId(ref.conversationId),
    touchConversationAsync: async (conversationId, at) =>
      manager.touchConversation(conversationId, at),
    channel: "feishu",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "feishu" || input.placement === "child") {
        return null;
      }
      assertCurrent();
      input.assertCurrent?.();
      const bound = manager.bindConversation({
        conversationId: input.conversation.conversationId,
        parentConversationId: input.conversation.parentConversationId,
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
        metadata: input.metadata,
      });
      return bound ? toSessionBindingRecord(bound, bindingTimeouts) : null;
    },
    project: (record: FeishuThreadBindingRecord) => toSessionBindingRecord(record, bindingTimeouts),
    listBySessionKey: manager.listBySessionKey,
    getByConversation: (ref) => manager.getByConversationId(ref.conversationId),
    touchConversation: manager.touchConversation,
    unbindConversation: manager.unbindConversation,
    unbindBySessionKey: (sessionKey) => manager.unbindBySessionKey(sessionKey.trim()),
  });

  registerSessionBindingAdapterV2(sessionBindingAdapter);

  managersByAccountId.set(accountId, manager);
  return manager;
}

export function getFeishuThreadBindingManager(
  accountId?: string,
): FeishuThreadBindingManager | null {
  return getState().managersByAccountId.get(normalizeAccountId(accountId)) ?? null;
}
