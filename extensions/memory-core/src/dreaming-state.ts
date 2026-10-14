import { createHash } from "node:crypto";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { captureMemoryMutationAuthority } from "./memory-mutation-authority.js";

const MEMORY_CORE_PLUGIN_ID = "memory-core";
export const DREAMING_DAILY_INGESTION_NAMESPACE = "dreaming-daily-ingestion";
export const DREAMING_SESSION_INGESTION_FILES_NAMESPACE = "dreaming-session-ingestion-files";
export const DREAMING_SESSION_INGESTION_SEEN_NAMESPACE = "dreaming-session-ingestion-seen";
export const SESSION_BACKFILL_REWIND_NAMESPACE = "session-backfill-rewind";
export const DREAMING_MEMORY_BACKUP_NAMESPACE = "dreaming-memory-backups";
export const SHORT_TERM_RECALL_NAMESPACE = "short-term-recall";
export const SHORT_TERM_PHASE_SIGNAL_NAMESPACE = "short-term-phase-signals";
export const SHORT_TERM_META_NAMESPACE = "short-term-meta";
export const SHORT_TERM_LOCK_NAMESPACE = "short-term-locks";

const DREAMING_WORKSPACE_STATE_MAX_ENTRIES = 50_000;
const WORKSPACE_STATE_YIELD_EVERY = 10;
export const SHORT_TERM_LOCK_MAX_ENTRIES = 4_096;
export const SESSION_SEEN_HASHES_PER_CHUNK = 512;

export type MemoryCoreOpenKeyedStore = <T>(
  options: OpenKeyedStoreOptions,
) => PluginStateKeyedStore<T>;

type WorkspaceValue<T> = {
  version: 1;
  workspaceKey: string;
  workspaceDir: string;
  key: string;
  value: T;
};

type MemoryCoreWorkspaceEntry<T> = { key: string; value: T };

type MemoryCoreWorkspaceParams = {
  namespace: string;
  workspaceDir: string;
};

type WriteMemoryCoreWorkspaceEntriesParams<T> = MemoryCoreWorkspaceParams & {
  entries: Array<MemoryCoreWorkspaceEntry<T>>;
};

type WriteMemoryCoreWorkspaceEntryParams<T> = MemoryCoreWorkspaceParams &
  MemoryCoreWorkspaceEntry<T>;

const dreamingState = createPluginRuntimeStore<MemoryCoreOpenKeyedStore>({
  key: "memory-core:dreaming-state",
  errorMessage: "memory-core dreaming SQLite state store is not configured",
});

export const configureMemoryCoreDreamingState = dreamingState.setRuntime;

export function openMemoryCoreStateStore<T>(
  options: OpenKeyedStoreOptions,
): PluginStateKeyedStore<T> {
  const store = dreamingState.getRuntime()<T>(options);
  const assertCurrent = captureMemoryMutationAuthority();
  if (!assertCurrent) {
    return store;
  }
  if (!store.withCurrent) {
    throw new Error("Memory mutations require a host with action-bound SQLite stores");
  }
  return store.withCurrent({ assertCurrent });
}

export function normalizeMemoryCoreWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function memoryCoreWorkspaceStateKey(workspaceDir: string): string {
  return createHash("sha256").update(normalizeMemoryCoreWorkspaceKey(workspaceDir)).digest("hex");
}

function memoryCoreWorkspaceEntryKey(workspaceDir: string, logicalKey: string): string {
  const workspaceKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const itemKey = createHash("sha256").update(logicalKey).digest("hex");
  return `${workspaceKey}:${itemKey}`;
}

export function memoryCoreStateReference(namespace: string, workspaceDir: string): string {
  return `plugin-state:${MEMORY_CORE_PLUGIN_ID}/${namespace}/${memoryCoreWorkspaceStateKey(workspaceDir)}`;
}

function openWorkspaceStore<T>(namespace: string): PluginStateKeyedStore<WorkspaceValue<T>> {
  return openMemoryCoreStateStore<WorkspaceValue<T>>({
    namespace,
    maxEntries: DREAMING_WORKSPACE_STATE_MAX_ENTRIES,
  });
}

async function readWorkspaceStoreEntries<T>(store: PluginStateKeyedStore<T>, workspaceKey: string) {
  const prefix = `${workspaceKey}:`;
  // Lexical range reads remain optional for existing Plugin SDK adapters.
  if (!store.entriesInKeyRange) {
    return (await store.entries()).filter((entry) => entry.key.startsWith(prefix));
  }
  // Stable sorting retains the range's binary-key order for creation-time ties.
  return (
    await store.entriesInKeyRange({
      keyStartInclusive: prefix,
      keyEndExclusive: `${workspaceKey};`,
      limit: Number.MAX_SAFE_INTEGER,
      order: "asc",
    })
  ).toSorted((left, right) => left.createdAt - right.createdAt);
}

// Caller owns typed decoding for values read from plugin state.
export async function readMemoryCoreWorkspaceEntries<T>(
  params: MemoryCoreWorkspaceParams,
): Promise<Array<MemoryCoreWorkspaceEntry<T>>> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const entries = await readWorkspaceStoreEntries(
    openWorkspaceStore<T>(params.namespace),
    workspaceKey,
  );
  return entries
    .filter((entry) => entry.value.workspaceKey === workspaceKey)
    .map((entry) => ({ key: entry.value.key, value: entry.value.value }));
}

// Caller owns typed encoding for values written to plugin state.
export async function writeMemoryCoreWorkspaceEntries<T>(
  params: WriteMemoryCoreWorkspaceEntriesParams<T>,
): Promise<void> {
  const store = openWorkspaceStore<T>(params.namespace);
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const replacementKeys = new Set<string>();
  // Scalar store calls can finish synchronously; await alone does not service I/O.
  let completed = 0;
  for (const entry of params.entries) {
    const stateKey = memoryCoreWorkspaceEntryKey(params.workspaceDir, entry.key);
    replacementKeys.add(stateKey);
    await store.register(stateKey, {
      version: 1,
      workspaceKey,
      workspaceDir: path.resolve(params.workspaceDir),
      key: entry.key,
      value: entry.value,
    });
    if (++completed % WORKSPACE_STATE_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }
  for (const entry of await readWorkspaceStoreEntries(store, workspaceKey)) {
    if (!replacementKeys.has(entry.key)) {
      await store.delete(entry.key);
      if (++completed % WORKSPACE_STATE_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }
  }
}

// Caller owns typed encoding for values written to plugin state.
export async function writeMemoryCoreWorkspaceEntry<T>(
  params: WriteMemoryCoreWorkspaceEntryParams<T>,
): Promise<void> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  await openWorkspaceStore<T>(params.namespace).register(
    memoryCoreWorkspaceEntryKey(params.workspaceDir, params.key),
    {
      version: 1,
      workspaceKey,
      workspaceDir: path.resolve(params.workspaceDir),
      key: params.key,
      value: params.value,
    },
  );
}

export async function clearMemoryCoreWorkspaceNamespace(
  params: MemoryCoreWorkspaceParams,
): Promise<void> {
  await writeMemoryCoreWorkspaceEntries({ ...params, entries: [] });
}

export async function deleteMemoryCoreWorkspaceEntry(params: {
  namespace: string;
  workspaceDir: string;
  key: string;
}): Promise<void> {
  await openWorkspaceStore(params.namespace).delete(
    memoryCoreWorkspaceEntryKey(params.workspaceDir, params.key),
  );
}
