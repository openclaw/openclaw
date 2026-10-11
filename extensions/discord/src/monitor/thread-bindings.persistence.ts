import { createPluginStateErrorReporter } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDiscordRuntime } from "../runtime.js";
import {
  BINDINGS_BY_THREAD_ID,
  PERSIST_BY_ACCOUNT_ID,
  THREAD_BINDINGS_STATE,
  normalizePersistedBinding,
  openThreadBindingsStore,
  openThreadBindingsStoreAsync,
  removeBindingRecord,
  setBindingRecord,
} from "./thread-bindings.state.js";
import type { ThreadBindingManager, ThreadBindingRecord } from "./thread-bindings.types.js";

export function shouldPersistAnyBindingState(): boolean {
  return [...PERSIST_BY_ACCOUNT_ID.values()].some(Boolean);
}

export function shouldPersistBindingMutations(): boolean {
  return shouldPersistAnyBindingState() || THREAD_BINDINGS_STATE.loadedPersistentBindings;
}

function snapshotThreadBindingJson(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized ? JSON.parse(serialized) : undefined;
}

export function snapshotThreadBindingMetadata(input: { metadata?: Record<string, unknown> }) {
  return asOptionalObjectRecord(
    snapshotThreadBindingJson(input.metadata ? { ...input.metadata } : undefined),
  );
}

function toPersistedBindingRecord(record: ThreadBindingRecord): ThreadBindingRecord {
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
  let authorityRefused = false;
  let targetCommitted = false;
  let committedWrites = 0;
  const assertCurrent = () => {
    try {
      params.assertCurrent?.();
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
    try {
      const store = openThreadBindingsStoreAsync();
      // Preserve the namespace's registration order and bounded eviction recency.
      for (const [key, record] of records) {
        assertCurrent();
        const persisted = toPersistedBindingRecord(record);
        await store.register(key, persisted, { assertCurrent });
        committedWrites += 1;
        targetCommitted ||= key === params.bindingKey;
      }
      assertCurrent();
      const entries = await store.entries();
      assertCurrent();
      for (const entry of entries) {
        if (!records.has(entry.key)) {
          await store.delete(entry.key, { assertCurrent });
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
    }
  }
  if (!targetCommitted) {
    assertCurrent();
  }
  // Deprecated synchronous calls overlapping worker writes are best effort.
  if (BINDINGS_BY_THREAD_ID.get(params.bindingKey) !== params.previous) {
    return;
  }
  if (params.next) {
    setBindingRecord(params.next);
  } else {
    removeBindingRecord(params.bindingKey);
  }
}

function persistBindingsSync(update?: {
  bindingKey: string;
  transform: (record: ThreadBindingRecord) => ThreadBindingRecord;
}): ThreadBindingRecord | undefined {
  const store = openThreadBindingsStore();
  let updatedRecord: ThreadBindingRecord | undefined;
  for (const [key, record] of BINDINGS_BY_THREAD_ID) {
    if (key === update?.bindingKey) {
      if (!store.update) {
        throw new Error("Discord synchronous compatibility requires atomic state update");
      }
      const next = update.transform(record);
      store.update(key, () => toPersistedBindingRecord(next));
      updatedRecord = next;
      if (next !== record) {
        setBindingRecord(next);
      }
    } else {
      store.register(key, toPersistedBindingRecord(record));
    }
  }
  for (const entry of store.entries()) {
    if (!BINDINGS_BY_THREAD_ID.has(entry.key)) {
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
    (!params.minIntervalMs ||
      now - THREAD_BINDINGS_STATE.lastPersistedAtMs >= params.minIntervalMs);
  if (persist) {
    try {
      const updated = persistBindingsSync(params);
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
  const next = params.transform(record);
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
    return removeBindingRecord(bindingKey);
  }
  let removed: ThreadBindingRecord | null = null;
  try {
    const store = openThreadBindingsStore();
    store.delete(bindingKey);
    removed = removeBindingRecord(bindingKey);
    persistBindingsSync();
    return removed;
  } catch {
    THREAD_BINDINGS_STATE.persistenceAvailable = false;
    return removed ?? removeBindingRecord(bindingKey);
  }
}
