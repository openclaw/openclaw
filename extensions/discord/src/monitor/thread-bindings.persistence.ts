import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getDiscordRuntime } from "../runtime.js";
import {
  BINDINGS_BY_THREAD_ID,
  PERSIST_BY_ACCOUNT_ID,
  THREAD_BINDINGS_STATE,
  THREAD_BINDINGS_NAMESPACE,
  THREAD_BINDINGS_MAX_ENTRIES,
  normalizePersistedBinding,
  openThreadBindingsStore,
  removeBindingRecord,
  setBindingRecord,
  type ThreadBindingPersistence,
} from "./thread-bindings.state.js";
import type {
  PersistedThreadBindingRecord,
  ThreadBindingManager,
  ThreadBindingRecord,
} from "./thread-bindings.types.js";

export function shouldPersistAnyBindingState(): boolean {
  for (const value of PERSIST_BY_ACCOUNT_ID.values()) {
    if (value) {
      return true;
    }
  }
  return false;
}

export function shouldPersistBindingMutations(): boolean {
  if (shouldPersistAnyBindingState()) {
    return true;
  }
  return THREAD_BINDINGS_STATE.loadedPersistentBindings;
}

export function snapshotThreadBindingJson(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized ? JSON.parse(serialized) : undefined;
}

function toPersistedBindingRecord(record: ThreadBindingRecord): PersistedThreadBindingRecord {
  return (
    normalizePersistedBinding(record.threadId, snapshotThreadBindingJson(record)) ?? { ...record }
  );
}

export function runThreadBindingAccountOperation<T>(
  managers: readonly ThreadBindingManager[],
  operation: () => Promise<T>,
): Promise<T> {
  if (managers.length === 0) {
    return operation();
  }
  const tails = THREAD_BINDINGS_STATE.accountOperationTails;
  const predecessors = managers.map((manager) => tails.get(manager) ?? Promise.resolve());
  const result = Promise.all(predecessors).then(operation);
  const settled = result.then(
    () => {},
    () => {},
  );
  // Reserve every account before yielding; shared persistence is acquired only afterward.
  for (const manager of managers) {
    tails.set(manager, settled);
  }
  // Idle accounts must not retain the completed caller's async context.
  void settled.then(() => {
    for (const manager of managers) {
      if (tails.get(manager) === settled) {
        tails.delete(manager);
      }
    }
  });
  return result;
}

export function drainThreadBindingAccountOperations(manager: ThreadBindingManager): Promise<void> {
  return THREAD_BINDINGS_STATE.accountOperationTails.get(manager) ?? Promise.resolve();
}

export function runThreadBindingMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = THREAD_BINDINGS_STATE.mutationTail.then(operation);
  THREAD_BINDINGS_STATE.mutationTail = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function drainThreadBindingMutations(): Promise<void> {
  return THREAD_BINDINGS_STATE.mutationTail;
}

export async function commitBindingRecord(params: {
  bindingKey: string;
  previous: ThreadBindingRecord | undefined;
  next: ThreadBindingRecord | null;
  persist: boolean;
  minIntervalMs?: number;
  assertCurrent?: () => void;
}): Promise<void> {
  const revision = THREAD_BINDINGS_STATE.revision;
  let authorityRefused = false;
  let targetCommitted = false;
  let committedWrites = 0;
  const assertCurrent = () => {
    try {
      params.assertCurrent?.();
      if (
        THREAD_BINDINGS_STATE.revision !== revision ||
        BINDINGS_BY_THREAD_ID.get(params.bindingKey) !== params.previous
      ) {
        throw new Error("Discord thread binding changed during persistence");
      }
    } catch (error) {
      authorityRefused = true;
      throw error;
    }
  };
  assertCurrent();
  const now = Date.now();
  const persist =
    params.persist &&
    THREAD_BINDINGS_STATE.persistenceAvailable &&
    !(
      params.minIntervalMs &&
      THREAD_BINDINGS_STATE.lastPersistedAtMs > 0 &&
      now - THREAD_BINDINGS_STATE.lastPersistedAtMs < params.minIntervalMs
    );
  if (persist) {
    const records = new Map(BINDINGS_BY_THREAD_ID);
    if (params.next) {
      records.set(params.bindingKey, params.next);
    } else {
      records.delete(params.bindingKey);
    }
    const active: ThreadBindingPersistence = {
      targetKey: params.bindingKey,
      deletingTarget: params.next === null,
      nextRecord: params.next,
      writingKey: undefined,
      committedKeys: new Set<string>(),
    };
    THREAD_BINDINGS_STATE.activePersistence = active;
    try {
      const store = getDiscordRuntime().state.openKeyedStore<PersistedThreadBindingRecord>({
        namespace: THREAD_BINDINGS_NAMESPACE,
        maxEntries: THREAD_BINDINGS_MAX_ENTRIES,
      });
      // Preserve the namespace's registration order and bounded eviction recency.
      for (const [key, record] of records) {
        assertCurrent();
        const persisted = toPersistedBindingRecord(record);
        if (key === params.bindingKey) {
          active.nextRecord = persisted;
        }
        active.writingKey = key;
        await store.register(key, persisted, { assertCurrent });
        active.writingKey = undefined;
        active.committedKeys.add(key);
        committedWrites += 1;
        targetCommitted ||= key === params.bindingKey;
      }
      assertCurrent();
      const entries = await store.entries();
      assertCurrent();
      for (const entry of entries) {
        if (!records.has(entry.key)) {
          active.writingKey = entry.key;
          await store.delete(entry.key, { assertCurrent });
          active.writingKey = undefined;
          active.committedKeys.add(entry.key);
          committedWrites += 1;
          targetCommitted ||= entry.key === params.bindingKey;
        }
      }
      if (!params.next) {
        targetCommitted = true;
      }
      assertCurrent();
      THREAD_BINDINGS_STATE.loadedPersistentBindings = records.size > 0;
      THREAD_BINDINGS_STATE.lastPersistedAtMs = now;
    } catch (error) {
      let failure = error;
      if (!authorityRefused) {
        try {
          assertCurrent();
        } catch (interruption) {
          failure = interruption;
        }
      }
      if (authorityRefused) {
        createPluginStateErrorReporter(
          getDiscordRuntime,
          "discord",
          "thread-bindings",
          "Discord thread binding save interrupted; acknowledged writes were retained.",
          () => ({ committedWrites, targetCommitted }),
        )(failure);
        if (!targetCommitted) {
          if (committedWrites === 0) {
            throw failure;
          }
          throw new Error(
            `Discord thread binding changed during persistence after ${committedWrites} acknowledged writes`,
            { cause: error },
          );
        }
      } else {
        THREAD_BINDINGS_STATE.persistenceAvailable = false;
        logVerbose("discord thread binding persistence unavailable; keeping bindings in memory");
      }
    } finally {
      delete THREAD_BINDINGS_STATE.activePersistence;
    }
  }
  if (!targetCommitted) {
    assertCurrent();
  }
  // A synchronous compatibility mutation may have consumed this committed result already.
  if (BINDINGS_BY_THREAD_ID.get(params.bindingKey) !== params.previous) {
    return;
  }
  if (params.next) {
    setBindingRecord(params.next);
  } else {
    removeBindingRecord(params.bindingKey);
  }
}

function persistBindingsSync(
  update?: {
    bindingKey: string;
    transform: (record: ThreadBindingRecord) => ThreadBindingRecord;
    observe?: (record: ThreadBindingRecord | undefined) => void;
  },
  removedKey?: string,
): ThreadBindingRecord | undefined {
  const store = openThreadBindingsStore();
  const active = THREAD_BINDINGS_STATE.activePersistence;
  let updatedRecord: ThreadBindingRecord | undefined;
  for (const [key, record] of BINDINGS_BY_THREAD_ID) {
    if (
      key === update?.bindingKey ||
      (active?.targetKey === key && active.deletingTarget) ||
      active?.writingKey === key ||
      active?.committedKeys.has(key)
    ) {
      if (!store.update) {
        throw new Error("Discord synchronous compatibility requires atomic state update");
      }
      let next: ThreadBindingRecord | undefined;
      store.update(key, (current) => {
        let base: ThreadBindingRecord | undefined = record;
        if (active?.targetKey === key) {
          if (!current && active.deletingTarget) {
            base = undefined;
          } else if (
            current &&
            active.nextRecord &&
            (active.writingKey === key || active.committedKeys.has(key)) &&
            JSON.stringify(toPersistedBindingRecord(current)) ===
              JSON.stringify(toPersistedBindingRecord(active.nextRecord))
          ) {
            // Native interop can observe a committed target before its worker reply arrives.
            base = normalizePersistedBinding(key, current) ?? record;
          }
        }
        if (key === update?.bindingKey) {
          update.observe?.(current && normalizePersistedBinding(key, current) ? base : undefined);
        }
        next = base ? (key === update?.bindingKey ? update.transform(base) : base) : undefined;
        return next ? toPersistedBindingRecord(next) : undefined;
      });
      if (key === update?.bindingKey) {
        updatedRecord = next;
      }
      // No-op reconciliation must not revoke the admitted mutation's settlement authority.
      if (next) {
        if (next !== record) {
          setBindingRecord(next);
        }
      } else if (!(active?.targetKey === key && active.deletingTarget)) {
        removeBindingRecord(key);
      }
    } else {
      store.register(key, toPersistedBindingRecord(record));
    }
  }
  for (const entry of store.entries()) {
    if (!BINDINGS_BY_THREAD_ID.has(entry.key)) {
      if (entry.key !== removedKey && active?.targetKey === entry.key && !active.deletingTarget) {
        const committed = normalizePersistedBinding(entry.key, entry.value);
        if (committed) {
          setBindingRecord(committed);
          continue;
        }
      }
      store.delete(entry.key);
    }
  }
  THREAD_BINDINGS_STATE.loadedPersistentBindings = BINDINGS_BY_THREAD_ID.size > 0;
  THREAD_BINDINGS_STATE.lastPersistedAtMs = Date.now();
  return updatedRecord;
}

/** Public SDK compatibility only; bundled callers await worker mutations. */
export function updateBindingRecordSync(params: {
  bindingKey: string;
  transform: (record: ThreadBindingRecord) => ThreadBindingRecord;
  persist: boolean;
  minIntervalMs?: number;
}): ThreadBindingRecord | null {
  const record = BINDINGS_BY_THREAD_ID.get(params.bindingKey);
  if (!record) {
    return null;
  }
  const now = Date.now();
  const persist =
    params.persist &&
    THREAD_BINDINGS_STATE.persistenceAvailable &&
    (THREAD_BINDINGS_STATE.activePersistence ||
      !params.minIntervalMs ||
      now - THREAD_BINDINGS_STATE.lastPersistedAtMs >= params.minIntervalMs);
  let observed: ThreadBindingRecord | undefined;
  if (persist) {
    try {
      const updated = persistBindingsSync({
        ...params,
        observe: (current) => {
          observed = current;
        },
      });
      return updated ?? null;
    } catch {
      THREAD_BINDINGS_STATE.persistenceAvailable = false;
      logVerbose("discord thread binding persistence unavailable; keeping bindings in memory");
    }
  }
  const current = BINDINGS_BY_THREAD_ID.get(params.bindingKey);
  if (current !== record) {
    return current ?? null;
  }
  if (THREAD_BINDINGS_STATE.activePersistence?.targetKey === params.bindingKey && !observed) {
    logVerbose("discord synchronous binding update skipped: pending target read unavailable");
    return null;
  }
  const next = params.transform(observed ?? record);
  setBindingRecord(next);
  return next;
}

/** Public SDK compatibility only; bundled callers await worker mutations. */
export function removeBindingRecordSync(bindingKey: string): ThreadBindingRecord | null {
  const record = BINDINGS_BY_THREAD_ID.get(bindingKey);
  if (!record) {
    return null;
  }
  if (!shouldPersistBindingMutations() || !THREAD_BINDINGS_STATE.persistenceAvailable) {
    return THREAD_BINDINGS_STATE.activePersistence?.targetKey === bindingKey
      ? null
      : removeBindingRecord(bindingKey);
  }
  let removed: ThreadBindingRecord | null = null;
  let observed: ThreadBindingRecord | null = null;
  let replacement: ThreadBindingRecord | undefined;
  try {
    const store = openThreadBindingsStore();
    if (!store.deleteIf) {
      throw new Error("Discord synchronous compatibility requires atomic state deletion");
    }
    const deleted = store.deleteIf(bindingKey, (current) => {
      const normalized = normalizePersistedBinding(bindingKey, current);
      observed = normalized;
      const pending = THREAD_BINDINGS_STATE.activePersistence;
      if (
        normalized &&
        pending?.targetKey === bindingKey &&
        pending.nextRecord &&
        (pending.writingKey === bindingKey || pending.committedKeys.has(bindingKey)) &&
        JSON.stringify(toPersistedBindingRecord(normalized)) ===
          JSON.stringify(toPersistedBindingRecord(pending.nextRecord)) &&
        (normalized.targetSessionKey !== record.targetSessionKey ||
          normalized.targetKind !== record.targetKind)
      ) {
        replacement = normalized;
        return false;
      }
      return true;
    });
    if (replacement) {
      setBindingRecord(replacement);
      return null;
    }
    const pending = THREAD_BINDINGS_STATE.activePersistence;
    if (!deleted && pending?.targetKey === bindingKey && pending.deletingTarget) {
      // The admitted worker deletion owns settlement and its farewell, including a held reply.
      return null;
    }
    removed = removeBindingRecord(bindingKey);
    persistBindingsSync(undefined, bindingKey);
    return removed;
  } catch {
    THREAD_BINDINGS_STATE.persistenceAvailable = false;
    if (replacement) {
      setBindingRecord(replacement);
      return null;
    }
    if (
      THREAD_BINDINGS_STATE.activePersistence?.targetKey === bindingKey &&
      !observed &&
      !removed
    ) {
      logVerbose("discord synchronous binding removal skipped: pending target read unavailable");
      return null;
    }
    return removed ?? removeBindingRecord(bindingKey);
  }
}
