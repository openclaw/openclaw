import * as acpRuntime from "openclaw/plugin-sdk/acp-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  resolveThreadBindingLifecycle,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeAccountId, isAcpSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { runQueuedStoreWrite } from "openclaw/plugin-sdk/sqlite-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadTelegramSendModule } from "./send-runtime.js";
import {
  loadBindingsFromStore,
  persistBindingMutation,
  updateStoredBindingSync,
} from "./thread-bindings-persistence.js";
import {
  fromSessionBindingInput,
  normalizeDurationMs,
  normalizeTimestampMs,
  resolveBindingKey,
  summarizeLifecycleForLog,
  toSessionBindingRecord,
} from "./thread-bindings-session.js";
import {
  captureBindingMutation,
  finishBindingMutationScope,
  pendingBindingValue,
  getThreadBindingsState,
  listBindingsForAccount,
} from "./thread-bindings-state.js";
import {
  normalizeMetadataForStore,
  type TelegramThreadBindingManager,
  type TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";
import { resolveTelegramToken } from "./token.js";

const DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THREAD_BINDING_MAX_AGE_MS = 0;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
type TelegramThreadBindingManagerParams = {
  cfg: OpenClawConfig;
  accountId?: string;
  persist?: boolean;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  enableSweeper?: boolean;
};

export async function createTelegramThreadBindingManager(
  params: TelegramThreadBindingManagerParams,
): Promise<TelegramThreadBindingManager> {
  const accountId = normalizeAccountId(params.accountId);
  const prepared = { ...params };
  return await queueBindingWork(accountId, () =>
    initializeThreadBindingManager(prepared, accountId),
  );
}

function queueBindingWork<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  return runQueuedStoreWrite({
    queues: getThreadBindingsState().queues,
    storePath: accountId,
    label: "telegram thread bindings",
    fn,
  });
}

async function initializeThreadBindingManager(
  params: TelegramThreadBindingManagerParams,
  accountId: string,
): Promise<TelegramThreadBindingManager> {
  const existing = getThreadBindingsState().managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? true;
  const idleTimeoutMs = normalizeDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_THREAD_BINDING_MAX_AGE_MS);

  const loaded = await loadBindingsFromStore(accountId);
  for (const entry of loaded) {
    const key = resolveBindingKey({
      accountId,
      conversationId: entry.conversationId,
    });
    getThreadBindingsState().bindingsByAccountConversation.set(key, {
      ...entry,
      accountId,
    });
  }

  const startupBindings = listBindingsForAccount(accountId);
  const acpSessionKeys = new Set<string>();
  for (const binding of startupBindings) {
    if (binding.targetKind !== "acp" || !isAcpSessionKey(binding.targetSessionKey)) {
      continue;
    }
    acpSessionKeys.add(binding.targetSessionKey);
  }

  const staleSessionKeys = new Set<string>();
  const readAcpSessionEntryAsync = acpRuntime.readAcpSessionEntryAsync;
  for (const targetSessionKey of acpSessionKeys) {
    if (typeof readAcpSessionEntryAsync !== "function") {
      throw new Error(
        "ACP thread binding reconciliation requires asynchronous metadata reads. Upgrade the OpenClaw host.",
      );
    }
    const sessionEntry = await readAcpSessionEntryAsync({ sessionKey: targetSessionKey });
    if (!sessionEntry || sessionEntry.storeReadFailed) {
      continue;
    }
    const isStale =
      !sessionEntry.entry ||
      sessionEntry.entry.status === "failed" ||
      sessionEntry.entry.status === "killed" ||
      sessionEntry.entry.status === "timeout" ||
      sessionEntry.acp?.state === "error";
    if (isStale) {
      staleSessionKeys.add(targetSessionKey);
    }
  }

  for (const sessionKey of staleSessionKeys) {
    const bindingsToRemove = startupBindings.filter((b) => b.targetSessionKey === sessionKey);
    for (const binding of bindingsToRemove) {
      const bindingKey = resolveBindingKey({ accountId, conversationId: binding.conversationId });
      if (getThreadBindingsState().bindingsByAccountConversation.get(bindingKey) !== binding) {
        continue;
      }
      getThreadBindingsState().bindingsByAccountConversation.delete(bindingKey);
      await persistBindingMutation({
        accountId,
        persist,
        binding,
        remove: true,
        reason: "cleanup-stale",
      });
    }
    if (bindingsToRemove.length > 0) {
      logVerbose(
        `telegram thread binding: cleaned up ${bindingsToRemove.length} stale binding(s) for session ${sessionKey}`,
      );
    }
  }

  let sweepTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | undefined;
  const assertManagerCurrent = () => {
    if (getThreadBindingsState().managersByAccountId.get(accountId) !== manager) {
      throw new Error(`Telegram thread binding manager retired (${accountId})`);
    }
  };
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    if (stopping) {
      return Promise.reject(new Error(`Telegram thread binding manager stopping (${accountId})`));
    }
    return queueBindingWork(accountId, async () => {
      assertManagerCurrent();
      try {
        return await fn();
      } finally {
        finishBindingMutationScope(manager);
      }
    });
  };

  const manager: TelegramThreadBindingManager = {
    accountId,
    shouldPersistMutations: () => persist,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByConversationId: (conversationIdRaw) => {
      const conversationId = normalizeOptionalString(conversationIdRaw);
      if (!conversationId) {
        return undefined;
      }
      return getThreadBindingsState().bindingsByAccountConversation.get(
        resolveBindingKey({
          accountId,
          conversationId,
        }),
      );
    },
    listBySessionKey: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return listBindingsForAccount(accountId).filter(
        (entry) => entry.targetSessionKey === targetSessionKey,
      );
    },
    listBindings: () => listBindingsForAccount(accountId),
    touchConversation: (conversationIdRaw, at) => {
      const activityAt = at ?? Date.now();
      return mutate(async () => {
        const conversationId = normalizeOptionalString(conversationIdRaw);
        if (!conversationId) {
          return null;
        }
        const mutation = captureBindingMutation(manager, conversationId);
        const existingLocal = mutation.previous;
        if (!existingLocal) {
          return null;
        }
        const requestedActivityAt = normalizeTimestampMs(activityAt);
        const nextRecord: TelegramThreadBindingRecord = {
          ...existingLocal,
          lastActivityAt:
            at === undefined
              ? Math.max(existingLocal.lastActivityAt, requestedActivityAt)
              : requestedActivityAt,
        };
        mutation.prepare(nextRecord);
        const committed = await persistBindingMutation({
          accountId,
          persist: manager.shouldPersistMutations(),
          binding: nextRecord,
          reason: "touch",
          assertCurrent: mutation.assertCurrent,
        });
        mutation.publish(nextRecord, committed);
        return nextRecord;
      });
    },
    unbindConversation: ({ conversationId: conversationIdRaw, throwOnPersistError }) =>
      mutate(async () => {
        const conversationId = normalizeOptionalString(conversationIdRaw);
        if (!conversationId) {
          return null;
        }
        const mutation = captureBindingMutation(manager, conversationId);
        const removed = mutation.previous ?? null;
        if (!removed) {
          return null;
        }
        mutation.prepare(null);
        const committed = await persistBindingMutation({
          accountId,
          persist: manager.shouldPersistMutations(),
          binding: removed,
          remove: true,
          reason: "unbind-conversation",
          throwOnError: throwOnPersistError,
          assertCurrent: mutation.assertCurrent,
        });
        mutation.publish(null, committed);
        return removed;
      }),
    unbindBySessionKey: ({ targetSessionKey: targetSessionKeyRaw, throwOnPersistError }) =>
      mutate(async () => {
        const targetSessionKey = targetSessionKeyRaw.trim();
        if (!targetSessionKey) {
          return [];
        }
        const removed: TelegramThreadBindingRecord[] = [];
        for (const entry of listBindingsForAccount(accountId)) {
          if (entry.targetSessionKey !== targetSessionKey) {
            continue;
          }
          const mutation = captureBindingMutation(manager, entry.conversationId);
          const current = mutation.previous;
          if (!current || current.targetSessionKey !== targetSessionKey) {
            continue;
          }
          mutation.prepare(null);
          const committed = await persistBindingMutation({
            accountId,
            persist: manager.shouldPersistMutations(),
            binding: current,
            remove: true,
            reason: "unbind-session",
            throwOnError: throwOnPersistError,
            assertCurrent: mutation.assertCurrent,
          });
          mutation.publish(null, committed);
          removed.push(current);
        }
        return removed;
      }),
    updateBySessionKey: (targetSessionKey, update) =>
      mutate(() =>
        updateTelegramBindingsBySessionKey({
          manager,
          targetSessionKey,
          update,
        }),
      ),
    updateConversationSync: (conversationIdRaw, update) => {
      if (stopping) {
        return null;
      }
      assertManagerCurrent();
      const binding = manager.getByConversationId(conversationIdRaw);
      if (!binding) {
        return null;
      }
      const next = updateStoredBindingSync({
        binding,
        persist,
        update,
        pendingValueJson: pendingBindingValue(manager, binding.conversationId),
      });
      if (next === undefined) {
        return null;
      }
      const key = resolveBindingKey(binding);
      if (next) {
        getThreadBindingsState().bindingsByAccountConversation.set(key, next);
      } else {
        getThreadBindingsState().bindingsByAccountConversation.delete(key);
      }
      return next;
    },
    stop: () => {
      if (stopping) {
        return stopping;
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      stopping = queueBindingWork(accountId, async () => {
        unregisterSessionBindingAdapter({
          channel: "telegram",
          accountId,
          adapter: sessionBindingAdapter,
        });
        const state = getThreadBindingsState();
        const existingManager = state.managersByAccountId.get(accountId);
        if (existingManager === manager) {
          state.managersByAccountId.delete(accountId);
          // Live bindings belong to this manager generation; persisted rows reload on restart.
          for (const binding of listBindingsForAccount(accountId)) {
            state.bindingsByAccountConversation.delete(
              resolveBindingKey({ accountId, conversationId: binding.conversationId }),
            );
          }
        }
      });
      return stopping;
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "telegram",
    accountId,
    capabilities: {
      placements: ["current", "child"],
    },
    bind: (input) => {
      const prepared = {
        ...input,
        conversation: { ...input.conversation },
        metadata: normalizeMetadataForStore(input.metadata) ?? {},
      };
      return mutate(async () => {
        const assertCurrent = prepared.assertCurrent;
        if (prepared.conversation.channel !== "telegram") {
          return null;
        }
        const targetSessionKey = prepared.targetSessionKey.trim();
        const targetKind = prepared.targetKind;
        if (!targetSessionKey) {
          return null;
        }
        const placement = prepared.placement === "child" ? "child" : "current";
        const metadata = { ...prepared.metadata };
        let conversationId: string | undefined;
        let nativeTopicCreated = false;

        if (placement === "child") {
          const rawConversationId = prepared.conversation.conversationId?.trim() ?? "";
          const rawParent = prepared.conversation.parentConversationId?.trim() ?? "";
          const chatId = rawParent || rawConversationId;
          if (!chatId) {
            logVerbose(
              `telegram: child bind failed: could not resolve group chat ID from conversationId=${rawConversationId}`,
            );
            return null;
          }
          if (!chatId.startsWith("-")) {
            logVerbose(
              `telegram: child bind failed: conversationId "${chatId}" looks like a bare topic ID, not a group chat ID (expected to start with "-"). Provide a full chatId:topic:topicId conversationId or set parentConversationId to the group chat ID.`,
            );
            return null;
          }
          const threadName =
            (normalizeOptionalString(metadata.threadName) ?? "") ||
            (normalizeOptionalString(metadata.label) ?? "") ||
            `Agent: ${targetSessionKey.split(":").pop()}`;
          try {
            const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
            if (!tokenResolution.token) {
              return null;
            }
            const { createForumTopicTelegram } = await loadTelegramSendModule();
            const result = await createForumTopicTelegram(chatId, threadName, {
              cfg: params.cfg,
              token: tokenResolution.token,
              accountId,
              ...(assertCurrent ? { assertPlatformSendAuthorized: assertCurrent } : {}),
            });
            conversationId = `${result.chatId}:topic:${result.topicId}`;
            nativeTopicCreated = true;
          } catch (err) {
            logVerbose(
              `telegram: child thread-binding failed for ${chatId}: ${formatErrorMessage(err)}`,
            );
            return null;
          }
        } else {
          conversationId = normalizeOptionalString(prepared.conversation.conversationId);
        }

        if (!conversationId) {
          return null;
        }
        const mutation = captureBindingMutation(manager, conversationId);
        const record = fromSessionBindingInput({
          accountId,
          existing: mutation.previous,
          input: {
            targetSessionKey,
            targetKind,
            conversationId,
            metadata,
          },
        });
        if (!nativeTopicCreated) {
          assertCurrent?.();
        }
        mutation.prepare(record);
        // Memory-only publication must not yield after checking command authority.
        const committed =
          manager.shouldPersistMutations() &&
          (await persistBindingMutation({
            accountId,
            persist: true,
            binding: record,
            reason: "bind",
            throwOnError: true,
            assertCurrent: () => {
              mutation.assertCurrent();
              if (!nativeTopicCreated) {
                assertCurrent?.();
              }
            },
          }));
        mutation.publish(record, committed);
        logVerbose(
          `telegram: bound conversation ${conversationId} -> ${targetSessionKey} (${summarizeLifecycleForLog(
            record,
            {
              idleTimeoutMs,
              maxAgeMs,
            },
          )})`,
        );
        return toSessionBindingRecord(record, {
          idleTimeoutMs,
          maxAgeMs,
        });
      });
    },
    listBySession: (targetSessionKey) =>
      manager.listBySessionKey(targetSessionKey).map((entry) =>
        toSessionBindingRecord(entry, {
          idleTimeoutMs,
          maxAgeMs,
        }),
      ),
    resolveByConversation: (ref) => {
      if (ref.channel !== "telegram") {
        return null;
      }
      const conversationId = normalizeOptionalString(ref.conversationId);
      if (!conversationId) {
        return null;
      }
      const record = manager.getByConversationId(conversationId);
      return record
        ? toSessionBindingRecord(record, {
            idleTimeoutMs,
            maxAgeMs,
          })
        : null;
    },
    touch: (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (conversationId) {
        const lastActivityAt = normalizeTimestampMs(at ?? Date.now());
        manager.updateConversationSync(conversationId, (current) => ({
          ...current,
          lastActivityAt,
        }));
      }
    },
    touchAsync: async (bindingId, at) => {
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (!conversationId) {
        return;
      }
      await manager.touchConversation(conversationId, at);
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = await manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
          sendFarewell: false,
          throwOnPersistError: true,
        });
        return removed.map((entry) =>
          toSessionBindingRecord(entry, {
            idleTimeoutMs,
            maxAgeMs,
          }),
        );
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = await manager.unbindConversation({
        conversationId,
        reason: input.reason,
        sendFarewell: false,
        throwOnPersistError: true,
      });
      return removed
        ? [
            toSessionBindingRecord(removed, {
              idleTimeoutMs,
              maxAgeMs,
            }),
          ]
        : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  const sweeperEnabled = params.enableSweeper !== false;
  if (sweeperEnabled) {
    let sweeping = false;
    sweepTimer = setInterval(() => {
      if (sweeping) {
        return;
      }
      sweeping = true;
      void mutate(async () => {
        const now = Date.now();
        for (const candidate of listBindingsForAccount(accountId)) {
          const mutation = captureBindingMutation(manager, candidate.conversationId);
          const record = mutation.previous;
          if (!record) {
            continue;
          }
          const { expiresAt, reason } = resolveThreadBindingLifecycle({
            record,
            defaultIdleTimeoutMs: idleTimeoutMs,
            defaultMaxAgeMs: maxAgeMs,
          });
          if (expiresAt === undefined || now < expiresAt) {
            continue;
          }
          mutation.prepare(null);
          const committed = await persistBindingMutation({
            accountId,
            persist,
            binding: record,
            remove: true,
            reason: reason ?? "expired",
            assertCurrent: mutation.assertCurrent,
          });
          mutation.publish(null, committed);
        }
      })
        .catch((error: unknown) => {
          logVerbose(`telegram thread bindings sweep failed (${accountId}): ${String(error)}`);
        })
        .finally(() => {
          sweeping = false;
        });
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  getThreadBindingsState().managersByAccountId.set(accountId, manager);
  return manager;
}

export function getTelegramThreadBindingManager(
  accountId?: string,
): TelegramThreadBindingManager | null {
  return getThreadBindingsState().managersByAccountId.get(normalizeAccountId(accountId)) ?? null;
}

async function updateTelegramBindingsBySessionKey(params: {
  manager: TelegramThreadBindingManager;
  targetSessionKey: string;
  update: (entry: TelegramThreadBindingRecord, now: number) => TelegramThreadBindingRecord;
}): Promise<TelegramThreadBindingRecord[]> {
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const now = Date.now();
  const updated: TelegramThreadBindingRecord[] = [];
  for (const entry of params.manager.listBySessionKey(targetSessionKey)) {
    const mutation = captureBindingMutation(params.manager, entry.conversationId);
    const current = mutation.previous;
    if (!current || current.targetSessionKey !== targetSessionKey) {
      continue;
    }
    const next = params.update(current, now);
    mutation.prepare(next);
    const committed = await persistBindingMutation({
      accountId: params.manager.accountId,
      persist: params.manager.shouldPersistMutations(),
      binding: next,
      reason: "session-lifecycle-update",
      assertCurrent: mutation.assertCurrent,
    });
    mutation.publish(next, committed);
    updated.push(next);
  }
  return updated;
}

export async function setTelegramThreadBindingIdleTimeoutBySessionKeyAsync(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): Promise<TelegramThreadBindingRecord[]> {
  const manager = getTelegramThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const idleTimeoutMs = normalizeDurationMs(params.idleTimeoutMs, 0);
  return manager.updateBySessionKey(params.targetSessionKey, (entry, now) => ({
    ...entry,
    idleTimeoutMs,
    lastActivityAt: now,
  }));
}

export async function setTelegramThreadBindingMaxAgeBySessionKeyAsync(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): Promise<TelegramThreadBindingRecord[]> {
  const manager = getTelegramThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, 0);
  return manager.updateBySessionKey(params.targetSessionKey, (entry, now) => ({
    ...entry,
    maxAgeMs,
    lastActivityAt: now,
  }));
}

function updateTelegramBindingsSynchronously(params: {
  accountId?: string;
  targetSessionKey: string;
  update: (entry: TelegramThreadBindingRecord, now: number) => TelegramThreadBindingRecord;
}): TelegramThreadBindingRecord[] {
  const manager = getTelegramThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const targetSessionKey = params.targetSessionKey.trim();
  const now = Date.now();
  const updated: TelegramThreadBindingRecord[] = [];
  for (const entry of manager.listBySessionKey(targetSessionKey)) {
    const next = manager.updateConversationSync(entry.conversationId, (current) =>
      current.targetSessionKey === targetSessionKey ? params.update(current, now) : undefined,
    );
    if (next?.targetSessionKey === targetSessionKey) {
      updated.push(next);
    }
  }
  return updated;
}

/** @deprecated Use the Async counterpart. Retained through the next Plugin SDK major. */
export function setTelegramThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): TelegramThreadBindingRecord[] {
  const idleTimeoutMs = normalizeDurationMs(params.idleTimeoutMs, 0);
  return updateTelegramBindingsSynchronously({
    ...params,
    update: (entry, now) => ({ ...entry, idleTimeoutMs, lastActivityAt: now }),
  });
}

/** @deprecated Use the Async counterpart. Retained through the next Plugin SDK major. */
export function setTelegramThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): TelegramThreadBindingRecord[] {
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, 0);
  return updateTelegramBindingsSynchronously({
    ...params,
    update: (entry, now) => ({ ...entry, maxAgeMs, lastActivityAt: now }),
  });
}
