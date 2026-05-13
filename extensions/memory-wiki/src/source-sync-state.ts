import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type MemoryWikiImportedSourceGroup = "bridge" | "unsafe-local";

type MemoryWikiImportedSourceStateEntry = {
  group: MemoryWikiImportedSourceGroup;
  pagePath: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
};

type MemoryWikiImportedSourceState = {
  version: 1;
  entries: Record<string, MemoryWikiImportedSourceStateEntry>;
};

type PersistedMemoryWikiImportedSourceStateEntry = MemoryWikiImportedSourceStateEntry & {
  vaultHash: string;
  syncKey: string;
};

const sourceSyncStore = createPluginStateKeyedStore<PersistedMemoryWikiImportedSourceStateEntry>(
  "memory-wiki",
  {
    namespace: "source-sync",
    maxEntries: 100_000,
  },
);

function hashSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function normalizeVaultRoot(vaultRoot: string): string {
  return path.resolve(vaultRoot);
}

function resolveVaultHash(vaultRoot: string): string {
  return hashSegment(normalizeVaultRoot(vaultRoot));
}

function resolveSourceSyncStoreKey(vaultHash: string, syncKey: string): string {
  return `${vaultHash}:${hashSegment(syncKey)}`;
}

export async function readMemoryWikiSourceSyncState(
  vaultRoot: string,
): Promise<MemoryWikiImportedSourceState> {
  const vaultHash = resolveVaultHash(vaultRoot);
  const entries: Record<string, MemoryWikiImportedSourceStateEntry> = {};
  for (const row of await sourceSyncStore.entries()) {
    if (row.value.vaultHash !== vaultHash) {
      continue;
    }
    entries[row.value.syncKey] = {
      group: row.value.group,
      pagePath: row.value.pagePath,
      sourcePath: row.value.sourcePath,
      sourceUpdatedAtMs: row.value.sourceUpdatedAtMs,
      sourceSize: row.value.sourceSize,
      renderFingerprint: row.value.renderFingerprint,
    };
  }
  return {
    version: 1,
    entries,
  };
}

export async function writeMemoryWikiSourceSyncState(
  vaultRoot: string,
  state: MemoryWikiImportedSourceState,
): Promise<void> {
  const vaultHash = resolveVaultHash(vaultRoot);
  const activeStoreKeys = new Set<string>();
  for (const [syncKey, entry] of Object.entries(state.entries)) {
    const storeKey = resolveSourceSyncStoreKey(vaultHash, syncKey);
    activeStoreKeys.add(storeKey);
    await sourceSyncStore.register(storeKey, {
      vaultHash,
      syncKey,
      ...entry,
    });
  }
  for (const row of await sourceSyncStore.entries()) {
    if (row.value.vaultHash === vaultHash && !activeStoreKeys.has(row.key)) {
      await sourceSyncStore.delete(row.key);
    }
  }
}

export async function shouldSkipImportedSourceWrite(params: {
  vaultRoot: string;
  syncKey: string;
  expectedPagePath: string;
  expectedSourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
  state: MemoryWikiImportedSourceState;
}): Promise<boolean> {
  const entry = params.state.entries[params.syncKey];
  if (!entry) {
    return false;
  }
  if (
    entry.pagePath !== params.expectedPagePath ||
    entry.sourcePath !== params.expectedSourcePath ||
    entry.sourceUpdatedAtMs !== params.sourceUpdatedAtMs ||
    entry.sourceSize !== params.sourceSize ||
    entry.renderFingerprint !== params.renderFingerprint
  ) {
    return false;
  }
  const pagePath = path.join(params.vaultRoot, params.expectedPagePath);
  return await fs
    .access(pagePath)
    .then(() => true)
    .catch(() => false);
}

export async function pruneImportedSourceEntries(params: {
  vaultRoot: string;
  group: MemoryWikiImportedSourceGroup;
  activeKeys: Set<string>;
  state: MemoryWikiImportedSourceState;
}): Promise<number> {
  let removedCount = 0;
  for (const [syncKey, entry] of Object.entries(params.state.entries)) {
    if (entry.group !== params.group || params.activeKeys.has(syncKey)) {
      continue;
    }
    const pageAbsPath = path.join(params.vaultRoot, entry.pagePath);
    await fs.rm(pageAbsPath, { force: true }).catch(() => undefined);
    delete params.state.entries[syncKey];
    removedCount += 1;
  }
  return removedCount;
}

export function setImportedSourceEntry(params: {
  syncKey: string;
  entry: MemoryWikiImportedSourceStateEntry;
  state: MemoryWikiImportedSourceState;
}): void {
  params.state.entries[params.syncKey] = params.entry;
}
