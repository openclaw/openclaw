/**
 * Subagent registry state persistence bridge.
 *
 * Merges process-local active runs with persisted SQLite state for cross-process readers.
 */
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>) {
  try {
    saveSubagentRegistryToSqlite(runs);
    invalidateSubagentRunsCache();
  } catch {
    // ignore persistence failures
  }
}

export function persistSubagentRunsToDiskOrThrow(runs: Map<string, SubagentRunRecord>) {
  saveSubagentRegistryToSqlite(runs);
  invalidateSubagentRunsCache();
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromSqlite();
  if (restored.size === 0) {
    return 0;
  }
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    added += 1;
  }
  return added;
}

/** Cached disk snapshot to avoid repeated SQLite reads (called at ~22 Hz by consumers). */
let cachedDiskSnapshot: Map<string, SubagentRunRecord> | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 1000; // 1 s staleness is acceptable for cross-process visibility

/** Invalidate the cached disk snapshot after a write. */
export function invalidateSubagentRunsCache(): void {
  cachedDiskSnapshot = null;
  lastCacheTime = 0;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk =
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK === "1" ||
    !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadDisk) {
    try {
      const now = Date.now();
      if (!cachedDiskSnapshot || now - lastCacheTime >= CACHE_TTL_MS) {
        // Persisted state lets other worker processes observe active runs.
        cachedDiskSnapshot = loadSubagentRegistryFromSqlite();
        lastCacheTime = now;
      }
      for (const [runId, entry] of cachedDiskSnapshot.entries()) {
        merged.set(runId, entry);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns.entries()) {
    merged.set(runId, entry);
  }
  return merged;
}
