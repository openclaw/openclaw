// Memory Core dreaming state lives in SQLite-backed plugin state.
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";

export const MEMORY_CORE_PLUGIN_ID = "memory-core";
export const DREAMING_DAILY_INGESTION_NAMESPACE = "dreaming-daily-ingestion";
export const DREAMING_SESSION_INGESTION_FILES_NAMESPACE = "dreaming-session-ingestion-files";
export const DREAMING_SESSION_INGESTION_SEEN_NAMESPACE = "dreaming-session-ingestion-seen";
export const SHORT_TERM_RECALL_NAMESPACE = "short-term-recall";
export const SHORT_TERM_PHASE_SIGNAL_NAMESPACE = "short-term-phase-signals";
export const SHORT_TERM_META_NAMESPACE = "short-term-meta";
export const SHORT_TERM_LOCK_NAMESPACE = "short-term-locks";
export const SHORT_TERM_MEMORY_FILE_LOCK_NAMESPACE = "short-term-memory-file-locks";

export const DREAMING_WORKSPACE_STATE_MAX_ENTRIES = 50_000;
export const SHORT_TERM_LOCK_MAX_ENTRIES = 4_096;
export const SESSION_SEEN_HASHES_PER_CHUNK = 512;

export type MemoryCoreOpenKeyedStore = <T>(
  options: OpenKeyedStoreOptions,
) => PluginStateKeyedStore<T>;

type WorkspaceValue<T> = {
  version: 1;
  workspaceKey: string;
  workspaceDir: string;
  agentId?: string;
  key: string;
  value: T;
};

export type MemoryCoreWorkspaceEntry<T> = { key: string; value: T };

type MemoryCoreWorkspaceParams = {
  namespace: string;
  workspaceDir: string;
  agentId?: string;
};

type WriteMemoryCoreWorkspaceEntriesParams<T> = MemoryCoreWorkspaceParams & {
  entries: Array<MemoryCoreWorkspaceEntry<T>>;
};

type WriteMemoryCoreWorkspaceEntryParams<T> = MemoryCoreWorkspaceParams &
  MemoryCoreWorkspaceEntry<T>;

let configuredOpenKeyedStore: MemoryCoreOpenKeyedStore | undefined;

export function configureMemoryCoreDreamingState(openKeyedStore: MemoryCoreOpenKeyedStore): void {
  configuredOpenKeyedStore = openKeyedStore;
}

export async function configureMemoryCoreDreamingStateForTests(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { createPluginStateKeyedStoreForTests } =
    await import("openclaw/plugin-sdk/plugin-state-test-runtime");
  const testEnv = { ...env };
  configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>(MEMORY_CORE_PLUGIN_ID, { ...options, env: testEnv }),
  );
}

export function resetMemoryCoreDreamingStateForTests(): void {
  configuredOpenKeyedStore = undefined;
}

export function openMemoryCoreStateStore<T>(
  options: OpenKeyedStoreOptions,
): PluginStateKeyedStore<T> {
  if (!configuredOpenKeyedStore) {
    throw new Error("memory-core dreaming SQLite state store is not configured");
  }
  return configuredOpenKeyedStore<T>(options);
}

export function normalizeMemoryCoreWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeMemoryCoreAgentId(agentId: string | undefined): string | undefined {
  return agentId?.trim() ? normalizeAgentId(agentId) : undefined;
}

export function memoryCoreWorkspaceStateKey(workspaceDir: string, agentId?: string): string {
  const normalizedAgentId = normalizeMemoryCoreAgentId(agentId);
  const scope = normalizedAgentId
    ? `${normalizeMemoryCoreWorkspaceKey(workspaceDir)}\0${normalizedAgentId}`
    : normalizeMemoryCoreWorkspaceKey(workspaceDir);
  return createHash("sha256").update(scope).digest("hex");
}

export function memoryCoreWorkspaceEntryKey(
  workspaceDir: string,
  logicalKey: string,
  agentId?: string,
): string {
  const workspaceKey = memoryCoreWorkspaceStateKey(workspaceDir, agentId);
  const itemKey = createHash("sha256").update(logicalKey).digest("hex");
  return `${workspaceKey}:${itemKey}`;
}

export function memoryCoreStateReference(
  namespace: string,
  workspaceDir: string,
  agentId?: string,
): string {
  return `plugin-state:${MEMORY_CORE_PLUGIN_ID}/${namespace}/${memoryCoreWorkspaceStateKey(workspaceDir, agentId)}`;
}

function openWorkspaceStore<T>(namespace: string): PluginStateKeyedStore<WorkspaceValue<T>> {
  return openMemoryCoreStateStore<WorkspaceValue<T>>({
    namespace,
    maxEntries: DREAMING_WORKSPACE_STATE_MAX_ENTRIES,
  });
}

// Caller owns typed decoding for values read from plugin state.
export function readMemoryCoreWorkspaceEntries<T>(
  params: MemoryCoreWorkspaceParams,
): Promise<Array<MemoryCoreWorkspaceEntry<T>>>;
export async function readMemoryCoreWorkspaceEntries(
  params: MemoryCoreWorkspaceParams,
): Promise<Array<MemoryCoreWorkspaceEntry<unknown>>> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir, params.agentId);
  const prefix = `${workspaceKey}:`;
  const entries = await openWorkspaceStore<unknown>(params.namespace).entries();
  return entries
    .filter((entry) => entry.key.startsWith(prefix) && entry.value.workspaceKey === workspaceKey)
    .map((entry) => ({ key: entry.value.key, value: entry.value.value }));
}

// Caller owns typed encoding for values written to plugin state.
export function writeMemoryCoreWorkspaceEntries<T>(
  params: WriteMemoryCoreWorkspaceEntriesParams<T>,
): Promise<void>;
export async function writeMemoryCoreWorkspaceEntries(
  params: WriteMemoryCoreWorkspaceEntriesParams<unknown>,
): Promise<void> {
  const store = openWorkspaceStore<unknown>(params.namespace);
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir, params.agentId);
  const agentId = normalizeMemoryCoreAgentId(params.agentId);
  const prefix = `${workspaceKey}:`;
  const replacementKeys = new Set<string>();
  for (const entry of params.entries) {
    const stateKey = memoryCoreWorkspaceEntryKey(params.workspaceDir, entry.key, params.agentId);
    replacementKeys.add(stateKey);
    await store.register(stateKey, {
      version: 1,
      workspaceKey,
      workspaceDir: path.resolve(params.workspaceDir),
      ...(agentId ? { agentId } : {}),
      key: entry.key,
      value: entry.value,
    });
  }
  for (const entry of await store.entries()) {
    if (entry.key.startsWith(prefix) && !replacementKeys.has(entry.key)) {
      await store.delete(entry.key);
    }
  }
}

// Caller owns typed encoding for values written to plugin state.
export function writeMemoryCoreWorkspaceEntry<T>(
  params: WriteMemoryCoreWorkspaceEntryParams<T>,
): Promise<void>;
export async function writeMemoryCoreWorkspaceEntry(
  params: WriteMemoryCoreWorkspaceEntryParams<unknown>,
): Promise<void> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir, params.agentId);
  const agentId = normalizeMemoryCoreAgentId(params.agentId);
  await openWorkspaceStore<unknown>(params.namespace).register(
    memoryCoreWorkspaceEntryKey(params.workspaceDir, params.key, params.agentId),
    {
      version: 1,
      workspaceKey,
      workspaceDir: path.resolve(params.workspaceDir),
      ...(agentId ? { agentId } : {}),
      key: params.key,
      value: params.value,
    },
  );
}

export async function clearMemoryCoreWorkspaceNamespace(params: {
  namespace: string;
  workspaceDir: string;
  agentId?: string;
}): Promise<void> {
  const store = openWorkspaceStore(params.namespace);
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir, params.agentId);
  const prefix = `${workspaceKey}:`;
  for (const entry of await store.entries()) {
    if (entry.key.startsWith(prefix)) {
      await store.delete(entry.key);
    }
  }
}

export async function migrateMemoryCoreWorkspaceNamespaceToAgent(params: {
  namespace: string;
  workspaceDir: string;
  sourceWorkspaceDir?: string;
  agentId: string;
}): Promise<{ sourceEntries: number; migratedEntries: number; retainedAgentEntries: number }> {
  const agentId = normalizeAgentId(params.agentId);
  const sourceWorkspaceDir = params.sourceWorkspaceDir ?? params.workspaceDir;
  const sourceWorkspaceKey = memoryCoreWorkspaceStateKey(sourceWorkspaceDir);
  const targetWorkspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir, agentId);
  if (sourceWorkspaceKey === targetWorkspaceKey) {
    return { sourceEntries: 0, migratedEntries: 0, retainedAgentEntries: 0 };
  }

  const store = openWorkspaceStore<unknown>(params.namespace);
  const sourcePrefix = `${sourceWorkspaceKey}:`;
  const sourceEntries = (await store.entries()).filter(
    (entry) =>
      entry.key.startsWith(sourcePrefix) &&
      entry.value.workspaceKey === sourceWorkspaceKey &&
      !entry.value.agentId,
  );
  let migratedEntries = 0;
  let retainedAgentEntries = 0;
  for (const entry of sourceEntries) {
    const targetKey = memoryCoreWorkspaceEntryKey(params.workspaceDir, entry.value.key, agentId);
    const migrated = await store.registerIfAbsent(targetKey, {
      ...entry.value,
      workspaceKey: targetWorkspaceKey,
      workspaceDir: path.resolve(params.workspaceDir),
      agentId,
    });
    if (migrated) {
      migratedEntries += 1;
    } else {
      retainedAgentEntries += 1;
    }
    await store.delete(entry.key);
  }
  return { sourceEntries: sourceEntries.length, migratedEntries, retainedAgentEntries };
}
