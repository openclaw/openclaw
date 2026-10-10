import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { hasSqliteWorkerOutcomeUnknown } from "openclaw/plugin-sdk/sqlite-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  registerSessionBindingAdapterV2,
  resolveThreadBindingLifecycle,
  unregisterSessionBindingAdapter,
  warnPluginSdkDeprecation,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { getMatrixRuntime } from "../runtime.js";
import { claimCurrentTokenStorageState, resolveMatrixStateFilePath } from "./client/storage.js";
import type { MatrixAuth } from "./client/types.js";
import { assertMatrixSupportedStateFile } from "./retired-state.js";
import type { MatrixClient } from "./sdk.js";
import { resolveMatrixSqliteStateEnv, resolveMatrixSqliteStateKey } from "./sqlite-state.js";
import {
  createMatrixSessionBindingAdapter,
  sameBindingIncarnation,
} from "./thread-bindings-session-adapter.js";
import {
  deleteMatrixThreadBindingManagerEntry,
  getMatrixThreadBindingManager,
  getMatrixThreadBindingManagerEntry,
  listBindingsForAccount,
  removeBindingRecord,
  resolveBindingKey,
  setBindingRecord,
  setMatrixThreadBindingManagerEntry,
  type MatrixThreadBindingManagerV2,
  type MatrixThreadBindingRecord,
} from "./thread-bindings-shared.js";

const THREAD_BINDINGS_NAMESPACE = "thread-bindings";
const THREAD_BINDINGS_MAX_ENTRIES = 10_000;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const TOUCH_PERSIST_DELAY_MS = 30_000;

function createThreadBindingStore(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  assertCurrent?: () => void;
}) {
  return getMatrixRuntime().state.openKeyedStoreV2<MatrixThreadBindingRecord>(
    {
      namespace: THREAD_BINDINGS_NAMESPACE,
      maxEntries: THREAD_BINDINGS_MAX_ENTRIES,
      env: resolveMatrixSqliteStateEnv(params),
    },
    params.assertCurrent ? { assertCurrent: params.assertCurrent } : undefined,
  );
}

function buildThreadBindingStoreKey(record: {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string {
  const digest = createHash("sha256")
    .update(record.accountId)
    .update("\0")
    .update(record.parentConversationId ?? "")
    .update("\0")
    .update(record.conversationId)
    .digest("hex");
  return `${record.accountId}:${digest}`;
}

function normalizeBindingRecord(
  entry: unknown,
  accountId: string,
): MatrixThreadBindingRecord | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Partial<MatrixThreadBindingRecord>;
  if (record.accountId && record.accountId !== accountId) {
    return null;
  }
  const conversationId = normalizeOptionalString(record.conversationId);
  const parentConversationId = normalizeOptionalString(record.parentConversationId);
  const targetSessionKey = normalizeOptionalString(record.targetSessionKey) ?? "";
  if (!conversationId || !targetSessionKey) {
    return null;
  }
  const boundAt = resolveOptionalIntegerOption(record.boundAt) ?? Date.now();
  const lastActivityAt = resolveOptionalIntegerOption(record.lastActivityAt) ?? boundAt;
  return {
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
    targetKind: record.targetKind === "subagent" ? "subagent" : "acp",
    targetSessionKey,
    agentId: normalizeOptionalString(record.agentId) || undefined,
    label: normalizeOptionalString(record.label) || undefined,
    boundBy: normalizeOptionalString(record.boundBy) || undefined,
    boundAt,
    lastActivityAt: Math.max(lastActivityAt, boundAt),
    idleTimeoutMs: resolveOptionalIntegerOption(record.idleTimeoutMs, { min: 0 }),
    maxAgeMs: resolveOptionalIntegerOption(record.maxAgeMs, { min: 0 }),
  };
}

async function loadBindingsFromPluginState(params: {
  accountId: string;
  assertCurrent?: () => void;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<MatrixThreadBindingRecord[]> {
  const store = createThreadBindingStore(params);
  const loaded: MatrixThreadBindingRecord[] = [];
  for (const entry of await store.entries()) {
    const record = normalizeBindingRecord(entry.value, params.accountId);
    if (record) {
      loaded.push(record);
    }
  }
  return loaded;
}

function toPluginJsonValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

async function persistBindingsSnapshot(params: {
  accountId: string;
  bindings: MatrixThreadBindingRecord[];
  assertCurrent?: () => void;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<MatrixThreadBindingRecord[]> {
  const store = createThreadBindingStore(params);
  const liveKeys = new Set(params.bindings.map((record) => buildThreadBindingStoreKey(record)));
  const stored = new Map<string, MatrixThreadBindingRecord>();
  for (const entry of await store.entries()) {
    const record = normalizeBindingRecord(entry.value, params.accountId);
    if (record) {
      stored.set(entry.key, record);
    }
    if (record && !liveKeys.has(entry.key)) {
      await store.delete(entry.key);
    }
  }
  const committed: MatrixThreadBindingRecord[] = [];
  for (const record of params.bindings) {
    const key = buildThreadBindingStoreKey(record);
    const previous = stored.get(key);
    // A snapshot accepted behind a targeted touch must not restore its older activity time.
    const next =
      previous && sameBindingIncarnation(previous, record)
        ? { ...record, lastActivityAt: Math.max(record.lastActivityAt, previous.lastActivityAt) }
        : record;
    await store.register(key, toPluginJsonValue(next));
    committed.push(next);
  }
  return committed;
}

export async function createMatrixThreadBindingManager(params: {
  cfg: OpenClawConfig;
  accountId: string;
  auth: MatrixAuth;
  client: MatrixClient;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
  enableSweeper?: boolean;
  logVerboseMessage?: (message: string) => void;
}): Promise<MatrixThreadBindingManagerV2> {
  if (params.auth.accountId !== params.accountId) {
    throw new Error(
      `Matrix thread binding account mismatch: requested ${params.accountId}, auth resolved ${params.auth.accountId}`,
    );
  }
  const legacyFilePath = await resolveMatrixStateFilePath({
    filename: "thread-bindings.json",
    auth: params.auth,
    accountId: params.accountId,
    env: params.env,
    stateDir: params.stateDir,
  });
  await assertMatrixSupportedStateFile(legacyFilePath);
  const sqliteStateDir = path.dirname(legacyFilePath);
  const storageKey = resolveMatrixSqliteStateKey({ env: params.env, stateDir: sqliteStateDir });
  const existingEntry = getMatrixThreadBindingManagerEntry(params.accountId);
  if (existingEntry) {
    if (existingEntry.storageKey === storageKey) {
      return existingEntry.manager;
    }
    await existingEntry.manager.stop();
  }
  const loaded = await loadBindingsFromPluginState({
    accountId: params.accountId,
    env: params.env,
    stateDir: sqliteStateDir,
  });
  for (const record of loaded) {
    setBindingRecord(record);
  }

  const committedBindings = new Map(loaded.map((record) => [resolveBindingKey(record), record]));
  let persistQueue: Promise<void> = Promise.resolve();
  const publishCommittedBindings = (
    committed: MatrixThreadBindingRecord[],
    before: MatrixThreadBindingRecord[],
  ) => {
    const previousByKey = new Map(before.map((record) => [resolveBindingKey(record), record]));
    const currentByKey = new Map(
      listBindingsForAccount(params.accountId).map((record) => [resolveBindingKey(record), record]),
    );
    committedBindings.clear();
    for (const record of committed) {
      const key = resolveBindingKey(record);
      committedBindings.set(key, record);
      if (currentByKey.get(key) === previousByKey.get(key)) {
        setBindingRecord(record);
      }
    }
    for (const record of before) {
      const key = resolveBindingKey(record);
      if (!committedBindings.has(key) && currentByKey.get(key) === record) {
        removeBindingRecord(record);
      }
    }
  };
  const persistSnapshot = async (
    bindings: MatrixThreadBindingRecord[],
    before: MatrixThreadBindingRecord[],
    assertCurrent: () => void,
  ) => {
    try {
      const committed = await persistBindingsSnapshot({
        accountId: params.accountId,
        bindings,
        env: params.env,
        stateDir: sqliteStateDir,
        assertCurrent,
      });
      assertCurrent();
      return committed;
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        stopping = true;
        throw new Error(
          "Matrix thread binding persistence has an unknown outcome; restart the account",
          { cause: error },
        );
      }
      try {
        // Individual snapshot writes can commit before a later write fails or loses authority.
        const committed = await loadBindingsFromPluginState({
          accountId: params.accountId,
          env: params.env,
          stateDir: sqliteStateDir,
          assertCurrent: assertManagerCurrent,
        });
        assertManagerCurrent();
        publishCommittedBindings(committed, before);
      } catch (reconciliationError) {
        stopping = true;
        throw new AggregateError(
          [error, reconciliationError],
          "Matrix thread binding persistence could not be reconciled; restart the account",
          { cause: reconciliationError },
        );
      }
      throw error;
    }
  };
  const enqueuePersist = () => {
    const next = persistQueue
      .catch(() => {})
      .then(async () => {
        assertManagerCurrent();
        const snapshot = listBindingsForAccount(params.accountId);
        const committed = await persistSnapshot(snapshot, snapshot, assertManagerCurrent);
        publishCommittedBindings(committed, snapshot);
        await claimCurrentTokenStorageState({ rootDir: sqliteStateDir });
      });
    persistQueue = next;
    return next;
  };
  const persist = async () => await enqueuePersist();
  const persistSafely = (reason: string) => {
    void enqueuePersist().catch((err: unknown) => {
      params.logVerboseMessage?.(
        `matrix: failed persisting thread bindings account=${params.accountId} action=${reason}: ${String(err)}`,
      );
    });
  };
  const defaults = {
    idleTimeoutMs: params.idleTimeoutMs,
    maxAgeMs: params.maxAgeMs,
  };
  let persistTimer: NodeJS.Timeout | null = null;
  let touchPersistPending = false;
  const schedulePersist = (delayMs: number) => {
    touchPersistPending = true;
    if (persistTimer || stopPromise) {
      return;
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      touchPersistPending = false;
      persistSafely("delayed-touch");
    }, delayMs);
    persistTimer.unref?.();
  };
  const updateBindingsBySessionKey = (input: {
    targetSessionKey: string;
    field: "idleTimeoutMs" | "maxAgeMs";
    value: number;
    persistReason: string;
  }): MatrixThreadBindingRecord[] => {
    const method =
      input.field === "idleTimeoutMs" ? "setIdleTimeoutBySessionKey" : "setMaxAgeBySessionKey";
    warnPluginSdkDeprecation({
      pluginId: "matrix",
      family: "conversation-bindings",
      method: `MatrixThreadBindingManager.${method}`,
      replacement: `await ${method}Async()`,
      compatibility: "Legacy methods return cached results synchronously and defer persistence.",
    });
    const targetSessionKey = input.targetSessionKey.trim();
    if (!targetSessionKey) {
      return [];
    }
    const now = Date.now();
    const nextBindings = listBindingsForAccount(params.accountId)
      .filter((entry) => entry.targetSessionKey === targetSessionKey)
      .map((entry) =>
        Object.assign({}, entry, {
          [input.field]: Math.max(0, Math.floor(input.value)),
          lastActivityAt: now,
        }),
      );
    if (nextBindings.length === 0) {
      return [];
    }
    for (const entry of nextBindings) {
      setBindingRecord(entry);
    }
    persistSafely(input.persistReason);
    return nextBindings;
  };

  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const assertManagerCurrent = () => {
    if (stopping || getMatrixThreadBindingManagerEntry(params.accountId)?.manager !== manager) {
      throw new Error("Matrix thread binding manager was retired");
    }
  };
  const assertAcceptingMutation = () => {
    assertManagerCurrent();
    if (stopPromise) {
      throw new Error("Matrix thread binding manager is stopping");
    }
  };
  const mutateBindings = (
    prepare: (current: MatrixThreadBindingRecord[]) => MatrixThreadBindingRecord[] | null,
    assertInputCurrent?: () => void,
  ): Promise<MatrixThreadBindingRecord[]> => {
    assertAcceptingMutation();
    const operation = persistQueue
      .catch(() => {})
      .then(async () => {
        assertManagerCurrent();
        const before = listBindingsForAccount(params.accountId);
        const next = prepare(before);
        if (!next) {
          return before;
        }
        const beforeByKey = new Map(before.map((record) => [resolveBindingKey(record), record]));
        const assertCurrent = () => {
          assertManagerCurrent();
          assertInputCurrent?.();
          const current = listBindingsForAccount(params.accountId);
          if (
            current.length !== before.length ||
            current.some((record) => beforeByKey.get(resolveBindingKey(record)) !== record)
          ) {
            throw new Error("Matrix thread bindings changed before persistence completed");
          }
        };
        const committed = await persistSnapshot(next, before, assertCurrent);
        publishCommittedBindings(committed, before);
        await claimCurrentTokenStorageState({ rootDir: sqliteStateDir });
        return committed;
      });
    persistQueue = operation.then(() => {});
    void persistQueue.catch(() => {});
    return operation;
  };
  const removeBindingsAsync = async (records: readonly MatrixThreadBindingRecord[]) => {
    const requested = new Map(records.map((record) => [resolveBindingKey(record), record]));
    let removed: MatrixThreadBindingRecord[] = [];
    await mutateBindings((current) => {
      removed = current.filter((record) => {
        const expected = requested.get(resolveBindingKey(record));
        return expected && sameBindingIncarnation(record, expected);
      });
      const removedKeys = new Set(removed.map(resolveBindingKey));
      return removed.length
        ? current.filter((record) => !removedKeys.has(resolveBindingKey(record)))
        : null;
    });
    return removed;
  };
  const touchBinding = (bindingId: string, at?: number) => {
    warnPluginSdkDeprecation({
      pluginId: "matrix",
      family: "conversation-bindings",
      method: "MatrixThreadBindingManager.touchBinding",
      replacement: "await touchBindingAsync()",
      compatibility: "Legacy methods return cached results synchronously and defer persistence.",
    });
    assertAcceptingMutation();
    const record = listBindingsForAccount(params.accountId).find(
      (entry) => resolveBindingKey(entry) === bindingId.trim(),
    );
    if (!record) {
      return null;
    }
    const nextRecord = {
      ...record,
      lastActivityAt:
        typeof at === "number" && Number.isFinite(at)
          ? Math.max(record.lastActivityAt, Math.floor(at))
          : Date.now(),
    };
    setBindingRecord(nextRecord);
    schedulePersist(TOUCH_PERSIST_DELAY_MS);
    return nextRecord;
  };
  const touchBindingAsync = (bindingId: string, at?: number): Promise<void> => {
    assertAcceptingMutation();
    const expected = listBindingsForAccount(params.accountId).find(
      (entry) => resolveBindingKey(entry) === bindingId.trim(),
    );
    if (!expected) {
      return Promise.resolve();
    }
    const requestedAt = typeof at === "number" && Number.isFinite(at) ? Math.floor(at) : Date.now();
    const next = persistQueue
      .catch(() => {})
      .then(async () => {
        assertManagerCurrent();
        const previous = listBindingsForAccount(params.accountId).find(
          (entry) => resolveBindingKey(entry) === bindingId.trim(),
        );
        if (!previous || !sameBindingIncarnation(previous, expected)) {
          return;
        }
        const current = {
          ...previous,
          lastActivityAt: Math.max(previous.lastActivityAt, requestedAt),
        };
        setBindingRecord(current);
        const committed = committedBindings.get(resolveBindingKey(current));
        if (
          committed &&
          sameBindingIncarnation(committed, current) &&
          current.lastActivityAt - committed.lastActivityAt < TOUCH_PERSIST_DELAY_MS
        ) {
          if (current.lastActivityAt > committed.lastActivityAt) {
            schedulePersist(TOUCH_PERSIST_DELAY_MS);
          }
          return;
        }
        const assertCurrent = () => {
          assertManagerCurrent();
          if (!listBindingsForAccount(params.accountId).includes(current)) {
            throw new Error("Matrix thread binding changed while recording activity");
          }
        };
        const store = getMatrixRuntime().state.openKeyedStoreV2<MatrixThreadBindingRecord>(
          {
            namespace: THREAD_BINDINGS_NAMESPACE,
            maxEntries: THREAD_BINDINGS_MAX_ENTRIES,
            env: resolveMatrixSqliteStateEnv({ env: params.env, stateDir: sqliteStateDir }),
          },
          { assertCurrent },
        );
        const key = buildThreadBindingStoreKey(current);
        let observation = await store.observe(key);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          assertCurrent();
          const stored = normalizeBindingRecord(observation.value, params.accountId);
          if (!stored || !sameBindingIncarnation(stored, current)) {
            throw new Error("Matrix stored thread binding changed while recording activity");
          }
          if (current.lastActivityAt - stored.lastActivityAt < TOUCH_PERSIST_DELAY_MS) {
            committedBindings.set(resolveBindingKey(stored), stored);
            setBindingRecord({
              ...stored,
              lastActivityAt: Math.max(stored.lastActivityAt, current.lastActivityAt),
            });
            if (current.lastActivityAt > stored.lastActivityAt) {
              schedulePersist(TOUCH_PERSIST_DELAY_MS);
            }
            return;
          }
          const updated = {
            ...stored,
            lastActivityAt: Math.max(stored.lastActivityAt, current.lastActivityAt),
          };
          const result = await store.compareAndApply(key, observation.comparison, {
            operation: "update",
            action: "set",
            value: toPluginJsonValue(updated),
          });
          if (result.status === "conflict") {
            observation = result.current;
            continue;
          }
          assertCurrent();
          committedBindings.set(resolveBindingKey(updated), updated);
          setBindingRecord(updated);
          return;
        }
        throw new Error("Matrix thread binding changed repeatedly while recording activity");
      });
    persistQueue = next;
    return next;
  };
  const updateBindingsBySessionKeyAsync = async (
    input: Parameters<typeof updateBindingsBySessionKey>[0],
  ) => {
    const targetSessionKey = input.targetSessionKey.trim();
    const value = Math.max(0, Math.floor(input.value));
    const now = Date.now();
    const committed = await mutateBindings((current) => {
      if (
        !targetSessionKey ||
        !current.some((record) => record.targetSessionKey === targetSessionKey)
      ) {
        return null;
      }
      return current.map((record) =>
        record.targetSessionKey === targetSessionKey
          ? { ...record, [input.field]: value, lastActivityAt: now }
          : record,
      );
    });
    return committed.filter((record) => record.targetSessionKey === targetSessionKey);
  };

  const manager: MatrixThreadBindingManagerV2 = {
    accountId: params.accountId,
    getIdleTimeoutMs: () => defaults.idleTimeoutMs,
    getMaxAgeMs: () => defaults.maxAgeMs,
    persist,
    getByConversation: ({ conversationId, parentConversationId }) =>
      listBindingsForAccount(params.accountId).find((entry) => {
        if (entry.conversationId !== conversationId.trim()) {
          return false;
        }
        if (!parentConversationId) {
          return true;
        }
        return (entry.parentConversationId ?? "") === parentConversationId.trim();
      }),
    listBySessionKey: (targetSessionKey) =>
      listBindingsForAccount(params.accountId).filter(
        (entry) => entry.targetSessionKey === targetSessionKey.trim(),
      ),
    listBindings: () => listBindingsForAccount(params.accountId),
    touchBinding,
    touchBindingAsync,
    removeBindingsAsync,
    setIdleTimeoutBySessionKey: ({ targetSessionKey, idleTimeoutMs }) =>
      updateBindingsBySessionKey({
        targetSessionKey,
        field: "idleTimeoutMs",
        value: idleTimeoutMs,
        persistReason: "idle-timeout-update",
      }),
    setMaxAgeBySessionKey: ({ targetSessionKey, maxAgeMs }) =>
      updateBindingsBySessionKey({
        targetSessionKey,
        field: "maxAgeMs",
        value: maxAgeMs,
        persistReason: "max-age-update",
      }),
    setIdleTimeoutBySessionKeyAsync: ({ targetSessionKey, idleTimeoutMs }) =>
      updateBindingsBySessionKeyAsync({
        targetSessionKey,
        field: "idleTimeoutMs",
        value: idleTimeoutMs,
        persistReason: "idle-timeout-update",
      }),
    setMaxAgeBySessionKeyAsync: ({ targetSessionKey, maxAgeMs }) =>
      updateBindingsBySessionKeyAsync({
        targetSessionKey,
        field: "maxAgeMs",
        value: maxAgeMs,
        persistReason: "max-age-update",
      }),
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      if (sweepTimer) {
        clearInterval(sweepTimer);
      }
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      stopPromise = (async () => {
        try {
          await persistQueue;
          // Accepted touches may request a flush while the queue drains during stop.
          if (touchPersistPending) {
            touchPersistPending = false;
            await enqueuePersist();
          }
        } finally {
          stopping = true;
          unregisterSessionBindingAdapter({
            channel: "matrix",
            accountId: params.accountId,
            adapter: sessionBindingAdapter,
          });
          if (getMatrixThreadBindingManagerEntry(params.accountId)?.manager === manager) {
            deleteMatrixThreadBindingManagerEntry(params.accountId);
            for (const record of listBindingsForAccount(params.accountId)) {
              removeBindingRecord(record);
            }
          }
        }
      })();
      return stopPromise;
    },
  };

  let sweepTimer: NodeJS.Timeout | null = null;
  const { sessionBindingAdapter, unbindRecords } = createMatrixSessionBindingAdapter(params, {
    manager,
    defaults,
    committedBindings,
    assertManagerCurrent,
    assertAcceptingMutation,
    mutateBindings,
  });

  registerSessionBindingAdapterV2(sessionBindingAdapter);

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      const expired = listBindingsForAccount(params.accountId)
        .map((record) => ({
          record,
          lifecycle: resolveThreadBindingLifecycle({
            record,
            defaultIdleTimeoutMs: defaults.idleTimeoutMs,
            defaultMaxAgeMs: defaults.maxAgeMs,
          }),
        }))
        .filter(
          (entry) =>
            typeof entry.lifecycle.expiresAt === "number" &&
            entry.lifecycle.expiresAt <= now &&
            Boolean(entry.lifecycle.reason),
        );
      if (expired.length === 0) {
        return;
      }
      const reasonByBindingKey = new Map(
        expired.map(({ record, lifecycle }) => [resolveBindingKey(record), lifecycle.reason]),
      );
      void unbindRecords(
        expired.map(({ record }) => record),
        (record) => reasonByBindingKey.get(resolveBindingKey(record)),
        (record) => {
          const reason = reasonByBindingKey.get(resolveBindingKey(record));
          params.logVerboseMessage?.(
            `matrix: auto-unbinding ${record.conversationId} due to ${reason}`,
          );
        },
      ).catch((err: unknown) => {
        params.logVerboseMessage?.(
          `matrix: failed auto-unbinding expired bindings account=${params.accountId}: ${String(err)}`,
        );
      });
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  setMatrixThreadBindingManagerEntry(params.accountId, {
    storageKey,
    manager,
  });
  return manager;
}
export { getMatrixThreadBindingManager };
