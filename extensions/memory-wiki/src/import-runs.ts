import { createHash } from "node:crypto";
import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ResolvedMemoryWikiConfig } from "./config.js";

export type MemoryWikiImportRunSummary = {
  runId: string;
  importType: string;
  appliedAt: string;
  exportPath: string;
  sourcePath: string;
  conversationCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  status: "applied" | "rolled_back";
  rolledBackAt?: string;
  pagePaths: string[];
  samplePaths: string[];
};

type MemoryWikiImportRunsStatus = {
  runs: MemoryWikiImportRunSummary[];
  totalRuns: number;
  activeRuns: number;
  rolledBackRuns: number;
};

type PersistedMemoryWikiImportRunRecord = {
  vaultHash: string;
  runId: string;
  record: Record<string, unknown>;
};

const importRunStore = createPluginStateKeyedStore<PersistedMemoryWikiImportRunRecord>(
  "memory-wiki",
  {
    namespace: "import-runs",
    maxEntries: 10_000,
  },
);

function hashSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function resolveVaultHash(vaultRoot: string): string {
  return hashSegment(vaultRoot);
}

function resolveImportRunStoreKey(vaultRoot: string, runId: string): string {
  return `${resolveVaultHash(vaultRoot)}:${hashSegment(runId)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function normalizeImportRunSummary(raw: unknown): MemoryWikiImportRunSummary | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const runId = typeof record?.runId === "string" ? record.runId.trim() : "";
  const importType = typeof record?.importType === "string" ? record.importType.trim() : "";
  const appliedAt = typeof record?.appliedAt === "string" ? record.appliedAt.trim() : "";
  const exportPath = typeof record?.exportPath === "string" ? record.exportPath.trim() : "";
  const sourcePath = typeof record?.sourcePath === "string" ? record.sourcePath.trim() : "";
  if (!runId || !importType || !appliedAt || !exportPath || !sourcePath) {
    return null;
  }

  const createdPaths = asStringArray(record.createdPaths);
  const updatedPaths = Array.isArray(record.updatedPaths)
    ? record.updatedPaths
        .map((entry) => asRecord(entry))
        .map((entry) => (typeof entry?.path === "string" ? entry.path.trim() : ""))
        .filter((entry): entry is string => entry.length > 0)
    : [];
  const pagePaths = [...new Set([...createdPaths, ...updatedPaths])];
  const conversationCount =
    typeof record.conversationCount === "number" && Number.isFinite(record.conversationCount)
      ? Math.max(0, Math.floor(record.conversationCount))
      : createdPaths.length + updatedPaths.length;
  const createdCount =
    typeof record.createdCount === "number" && Number.isFinite(record.createdCount)
      ? Math.max(0, Math.floor(record.createdCount))
      : createdPaths.length;
  const updatedCount =
    typeof record.updatedCount === "number" && Number.isFinite(record.updatedCount)
      ? Math.max(0, Math.floor(record.updatedCount))
      : updatedPaths.length;
  const skippedCount =
    typeof record.skippedCount === "number" && Number.isFinite(record.skippedCount)
      ? Math.max(0, Math.floor(record.skippedCount))
      : Math.max(0, conversationCount - createdCount - updatedCount);
  const rolledBackAt =
    typeof record.rolledBackAt === "string" && record.rolledBackAt.trim().length > 0
      ? record.rolledBackAt.trim()
      : undefined;

  return {
    runId,
    importType,
    appliedAt,
    exportPath,
    sourcePath,
    conversationCount,
    createdCount,
    updatedCount,
    skippedCount,
    status: rolledBackAt ? "rolled_back" : "applied",
    ...(rolledBackAt ? { rolledBackAt } : {}),
    pagePaths,
    samplePaths: pagePaths.slice(0, 5),
  };
}

export async function writeMemoryWikiImportRunRecord(
  vaultRoot: string,
  record: Record<string, unknown> & { runId: string },
): Promise<void> {
  await importRunStore.register(resolveImportRunStoreKey(vaultRoot, record.runId), {
    vaultHash: resolveVaultHash(vaultRoot),
    runId: record.runId,
    record,
  });
}

export async function readMemoryWikiImportRunRecord<T extends { runId: string }>(
  vaultRoot: string,
  runId: string,
): Promise<T> {
  const entry = await importRunStore.lookup(resolveImportRunStoreKey(vaultRoot, runId));
  if (!entry) {
    throw new Error(`Memory Wiki import run not found: ${runId}`);
  }
  return entry.record as T;
}

export async function listMemoryWikiImportRunRecords(
  vaultRoot: string,
): Promise<Record<string, unknown>[]> {
  const vaultHash = resolveVaultHash(vaultRoot);
  return (await importRunStore.entries())
    .filter((entry) => entry.value.vaultHash === vaultHash)
    .map((entry) => entry.value.record);
}

export async function listMemoryWikiImportRuns(
  config: ResolvedMemoryWikiConfig,
  options?: { limit?: number },
): Promise<MemoryWikiImportRunsStatus> {
  const limit = Math.max(1, Math.floor(options?.limit ?? 10));
  const runs = (await listMemoryWikiImportRunRecords(config.vault.path))
    .map((record) => normalizeImportRunSummary(record))
    .filter((entry): entry is MemoryWikiImportRunSummary => entry !== null)
    .toSorted((left, right) => right.appliedAt.localeCompare(left.appliedAt));

  return {
    runs: runs.slice(0, limit),
    totalRuns: runs.length,
    activeRuns: runs.filter((entry) => entry.status === "applied").length,
    rolledBackRuns: runs.filter((entry) => entry.status === "rolled_back").length,
  };
}
