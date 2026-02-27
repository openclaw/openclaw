import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Coalescing write queue: only the most recent snapshot is persisted.
// If a write is already in progress, the next call schedules a follow-up
// that will capture the latest state, preventing lost updates and reducing
// redundant disk I/O from the 20+ fire-and-forget persist call sites.
let persistPending = false;
let persistScheduled = false;
let lastPersistedRuns: Map<string, SubagentRunRecord> | null = null;

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>) {
  lastPersistedRuns = runs;
  if (persistPending) {
    // A write is in-flight; mark that another is needed after it completes.
    persistScheduled = true;
    return;
  }
  persistPending = true;
  try {
    saveSubagentRegistryToDisk(runs);
  } catch {
    // ignore persistence failures
  } finally {
    persistPending = false;
    if (persistScheduled) {
      persistScheduled = false;
      // Drain: persist the latest snapshot that accumulated during the write.
      if (lastPersistedRuns) {
        persistSubagentRunsToDisk(lastPersistedRuns);
      }
    }
  }
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromDisk();
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

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk = !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadDisk) {
    try {
      // Persisted state lets other worker processes observe active runs.
      for (const [runId, entry] of loadSubagentRegistryFromDisk().entries()) {
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
