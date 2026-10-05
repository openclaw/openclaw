import { createHash } from "node:crypto";
import path from "node:path";
import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  asNullableRecord,
  normalizeOptionalString,
  normalizeUniqueTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";

type ChatGptImportRunEntry = {
  path: string;
  snapshotPath?: string;
  contentHash?: string;
  recoveryPaths?: string[];
};

export type ChatGptImportRunRecord = {
  version: 1;
  runId: string;
  importType: "chatgpt";
  exportPath: string;
  sourcePath: string;
  appliedAt: string;
  conversationCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  createdPaths: ChatGptImportRunEntry[];
  updatedPaths: ChatGptImportRunEntry[];
  rollbackStartedAt?: string;
  rollbackTargetsFinalizedAt?: string;
  rolledBackAt?: string;
};

type MemoryWikiImportRunStateStore = {
  read: (vaultRoot: string, runId: string) => Promise<ChatGptImportRunRecord | null>;
  write: (vaultRoot: string, record: ChatGptImportRunRecord) => Promise<void>;
  list: (vaultRoot: string) => Promise<ChatGptImportRunRecord[]>;
  rowCount: () => Promise<number>;
};

type MemoryWikiImportRunMetaStateRecord = Omit<
  ChatGptImportRunRecord,
  "createdPaths" | "updatedPaths"
> & {
  kind: "meta";
  vaultRootKey: string;
};

type MemoryWikiImportRunPathStateRecord = ChatGptImportRunEntry & {
  kind: "created-path" | "updated-path";
  vaultRootKey: string;
  runId: string;
  index: number;
};

type MemoryWikiImportRunStateRecord =
  | MemoryWikiImportRunMetaStateRecord
  | MemoryWikiImportRunPathStateRecord;

const MEMORY_WIKI_IMPORT_RUN_STATE_NAMESPACE = "import-runs";
export const MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES = 20_000;

let configuredImportRunStore: MemoryWikiImportRunStateStore | undefined;

export function resolveMemoryWikiImportRunsDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs");
}

function resolveVaultRootKey(vaultRoot: string): string {
  return createHash("sha256").update(path.resolve(vaultRoot), "utf8").digest("hex").slice(0, 32);
}

function resolveStateEntryKey(vaultRootKey: string, runId: string): string {
  return createHash("sha256").update(`${vaultRootKey}\0meta\0${runId}`, "utf8").digest("hex");
}

function resolvePathStateEntryKey(params: {
  vaultRootKey: string;
  runId: string;
  kind: MemoryWikiImportRunPathStateRecord["kind"];
  index: number;
  path: string;
}): string {
  return createHash("sha256")
    .update(
      `${params.vaultRootKey}\0${params.runId}\0${params.kind}\0${params.index}\0${params.path}`,
      "utf8",
    )
    .digest("hex");
}

function normalizeMetaRecord(raw: unknown): MemoryWikiImportRunMetaStateRecord | null {
  const record = asNullableRecord(raw);
  if (!record || record.kind !== "meta") {
    return null;
  }
  const vaultRootKey = typeof record.vaultRootKey === "string" ? record.vaultRootKey : "";
  const runId = normalizeOptionalString(record.runId) ?? "";
  const exportPath = normalizeOptionalString(record.exportPath) ?? "";
  const sourcePath = normalizeOptionalString(record.sourcePath) ?? "";
  const appliedAt = normalizeOptionalString(record.appliedAt) ?? "";
  if (
    record.version !== 1 ||
    record.importType !== "chatgpt" ||
    !vaultRootKey ||
    !runId ||
    !exportPath ||
    !sourcePath ||
    !appliedAt
  ) {
    return null;
  }
  const rolledBackAt = normalizeOptionalString(record.rolledBackAt);
  const rollbackStartedAt = normalizeOptionalString(record.rollbackStartedAt);
  const rollbackTargetsFinalizedAt = normalizeOptionalString(record.rollbackTargetsFinalizedAt);
  return {
    version: 1,
    kind: "meta",
    vaultRootKey,
    runId,
    importType: "chatgpt",
    exportPath,
    sourcePath,
    appliedAt,
    conversationCount: resolveNonNegativeIntegerOption(record.conversationCount, 0),
    createdCount: resolveNonNegativeIntegerOption(record.createdCount, 0),
    updatedCount: resolveNonNegativeIntegerOption(record.updatedCount, 0),
    skippedCount: resolveNonNegativeIntegerOption(record.skippedCount, 0),
    ...(rollbackStartedAt ? { rollbackStartedAt } : {}),
    ...(rollbackTargetsFinalizedAt ? { rollbackTargetsFinalizedAt } : {}),
    ...(rolledBackAt ? { rolledBackAt } : {}),
  };
}

function normalizePathRecord(raw: unknown): MemoryWikiImportRunPathStateRecord | null {
  const record = asNullableRecord(raw);
  if (
    !record ||
    (record.kind !== "created-path" && record.kind !== "updated-path") ||
    typeof record.vaultRootKey !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.path !== "string" ||
    typeof record.index !== "number" ||
    !Number.isFinite(record.index)
  ) {
    return null;
  }
  const snapshotPath = normalizeOptionalString(record.snapshotPath);
  const contentHash = normalizeOptionalString(record.contentHash);
  const recoveryPaths = normalizeUniqueTrimmedStringList(record.recoveryPaths);
  return {
    kind: record.kind,
    vaultRootKey: record.vaultRootKey,
    runId: record.runId,
    index: Math.max(0, Math.floor(record.index)),
    path: record.path,
    ...(snapshotPath ? { snapshotPath } : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(recoveryPaths.length > 0 ? { recoveryPaths } : {}),
  };
}

function importRunMetadata(
  record: Omit<ChatGptImportRunRecord, "createdPaths" | "updatedPaths">,
): Omit<ChatGptImportRunRecord, "createdPaths" | "updatedPaths"> {
  return {
    version: 1,
    runId: record.runId,
    importType: "chatgpt",
    exportPath: record.exportPath,
    sourcePath: record.sourcePath,
    appliedAt: record.appliedAt,
    conversationCount: record.conversationCount,
    createdCount: record.createdCount,
    updatedCount: record.updatedCount,
    skippedCount: record.skippedCount,
    ...(record.rollbackStartedAt ? { rollbackStartedAt: record.rollbackStartedAt } : {}),
    ...(record.rollbackTargetsFinalizedAt
      ? { rollbackTargetsFinalizedAt: record.rollbackTargetsFinalizedAt }
      : {}),
    ...(record.rolledBackAt ? { rolledBackAt: record.rolledBackAt } : {}),
  };
}

function composeImportRunRecord(
  meta: MemoryWikiImportRunMetaStateRecord,
  pathRows: MemoryWikiImportRunPathStateRecord[],
): ChatGptImportRunRecord {
  const toEntry = (row: MemoryWikiImportRunPathStateRecord): ChatGptImportRunEntry => ({
    path: row.path,
    ...(row.snapshotPath ? { snapshotPath: row.snapshotPath } : {}),
    ...(row.contentHash ? { contentHash: row.contentHash } : {}),
    ...(row.recoveryPaths ? { recoveryPaths: [...row.recoveryPaths] } : {}),
  });
  const createdPaths = pathRows
    .filter((row) => row.kind === "created-path")
    .toSorted((left, right) => left.index - right.index)
    .map(toEntry);
  const updatedPaths = pathRows
    .filter((row) => row.kind === "updated-path")
    .toSorted((left, right) => left.index - right.index)
    .map(toEntry);
  return { ...importRunMetadata(meta), createdPaths, updatedPaths };
}

function toMetaRecord(
  vaultRootKey: string,
  record: ChatGptImportRunRecord,
): MemoryWikiImportRunMetaStateRecord {
  const { version, ...metadata } = importRunMetadata(record);
  return { version, kind: "meta", vaultRootKey, ...metadata };
}

function toPathRecords(
  vaultRootKey: string,
  record: ChatGptImportRunRecord,
): MemoryWikiImportRunPathStateRecord[] {
  const toPathRecord = (
    entry: ChatGptImportRunEntry,
    index: number,
    kind: MemoryWikiImportRunPathStateRecord["kind"],
  ): MemoryWikiImportRunPathStateRecord => ({
    kind,
    vaultRootKey,
    runId: record.runId,
    index,
    path: entry.path,
    ...(kind === "updated-path" && entry.snapshotPath ? { snapshotPath: entry.snapshotPath } : {}),
    ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
    ...(entry.recoveryPaths ? { recoveryPaths: [...entry.recoveryPaths] } : {}),
  });
  return [
    ...record.createdPaths.map((entry, index) => toPathRecord(entry, index, "created-path")),
    ...record.updatedPaths.map((entry, index) => toPathRecord(entry, index, "updated-path")),
  ];
}

export function createMemoryWikiImportRunStateStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): MemoryWikiImportRunStateStore {
  const openStore = () =>
    openKeyedStore<MemoryWikiImportRunStateRecord>({
      namespace: MEMORY_WIKI_IMPORT_RUN_STATE_NAMESPACE,
      maxEntries: MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES,
    });

  return {
    async read(vaultRoot, runId) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const row = await openStore().lookup(resolveStateEntryKey(vaultRootKey, runId));
      const meta = normalizeMetaRecord(row);
      if (!meta || meta.vaultRootKey !== vaultRootKey) {
        return null;
      }
      const pathRows = (await openStore().entries())
        .map((entry) => normalizePathRecord(entry.value))
        .filter(
          (entry): entry is MemoryWikiImportRunPathStateRecord =>
            entry !== null && entry.vaultRootKey === vaultRootKey && entry.runId === runId,
        );
      return composeImportRunRecord(meta, pathRows);
    },
    async write(vaultRoot, record) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const store = openStore();
      const nextPathKeys = new Set<string>();
      for (const pathRecord of toPathRecords(vaultRootKey, record)) {
        const key = resolvePathStateEntryKey(pathRecord);
        nextPathKeys.add(key);
        await store.register(key, pathRecord);
      }
      // Path rows carry rollback recovery evidence. Commit the meta row last
      // so phase fences and rolledBackAt never become visible ahead of it.
      await store.register(
        resolveStateEntryKey(vaultRootKey, record.runId),
        toMetaRecord(vaultRootKey, record),
      );
      for (const row of await store.entries()) {
        const pathRecord = normalizePathRecord(row.value);
        if (
          pathRecord?.vaultRootKey === vaultRootKey &&
          pathRecord.runId === record.runId &&
          !nextPathKeys.has(row.key)
        ) {
          await store.delete(row.key);
        }
      }
    },
    async list(vaultRoot) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const metaRows = new Map<string, MemoryWikiImportRunMetaStateRecord>();
      const pathRows: MemoryWikiImportRunPathStateRecord[] = [];
      for (const row of await openStore().entries()) {
        const meta = normalizeMetaRecord(row.value);
        if (meta?.vaultRootKey === vaultRootKey) {
          metaRows.set(meta.runId, meta);
          continue;
        }
        const pathRecord = normalizePathRecord(row.value);
        if (pathRecord?.vaultRootKey === vaultRootKey) {
          pathRows.push(pathRecord);
        }
      }
      return [...metaRows.values()].map((meta) =>
        composeImportRunRecord(
          meta,
          pathRows.filter((row) => row.runId === meta.runId),
        ),
      );
    },
    async rowCount() {
      const store = openStore();
      return (await store.count?.()) ?? (await store.entries()).length;
    },
  };
}

export function configureMemoryWikiImportRunStateStore(
  store: MemoryWikiImportRunStateStore | undefined,
): void {
  configuredImportRunStore = store;
}

function resolveImportRunStore(store = configuredImportRunStore): MemoryWikiImportRunStateStore {
  if (!store) {
    throw new Error("Memory Wiki import run state store is not configured.");
  }
  return store;
}

export async function readMemoryWikiImportRunRecord(
  vaultRoot: string,
  runId: string,
  store?: MemoryWikiImportRunStateStore,
): Promise<ChatGptImportRunRecord | null> {
  return await resolveImportRunStore(store).read(vaultRoot, runId);
}

export async function writeMemoryWikiImportRunRecord(
  vaultRoot: string,
  record: ChatGptImportRunRecord,
  store?: MemoryWikiImportRunStateStore,
): Promise<void> {
  await resolveImportRunStore(store).write(vaultRoot, record);
}

export async function listMemoryWikiImportRunRecords(
  vaultRoot: string,
  store?: MemoryWikiImportRunStateStore,
): Promise<ChatGptImportRunRecord[]> {
  return await resolveImportRunStore(store).list(vaultRoot);
}

export async function countMemoryWikiImportRunStateRows(
  store?: MemoryWikiImportRunStateStore,
): Promise<number> {
  return await resolveImportRunStore(store).rowCount();
}
