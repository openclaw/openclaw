import { getSubagentRegistryMemoryVersion, subagentRuns } from "./subagent-registry-memory.js";
import {
  cloneReadonlySubagentRunRecord,
  createReadonlySubagentRunMap,
  getSubagentRegistryDiskReadSnapshot,
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
  type ReadonlySubagentRunRecord,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentRegistryReadSnapshot = {
  readonly source: "subagent-registry";
  readonly diskSignature: string | null;
  readonly memoryVersion: number;
  readonly runsById: ReadonlyMap<string, ReadonlySubagentRunRecord>;
  readonly inMemoryRunsById: ReadonlyMap<string, ReadonlySubagentRunRecord>;
};

type CachedSubagentRegistryReadSnapshot = {
  readonly shouldReadDisk: boolean;
  readonly diskSignature: string | null;
  readonly memoryVersion: number;
  readonly snapshot: SubagentRegistryReadSnapshot;
};

let cachedReadSnapshot: CachedSubagentRegistryReadSnapshot | null = null;

function shouldReadPersistedSubagentRegistry(): boolean {
  return (
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK === "1" ||
    !(process.env.VITEST || process.env.NODE_ENV === "test")
  );
}

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>) {
  try {
    saveSubagentRegistryToDisk(runs);
  } catch {
    // ignore persistence failures
  }
}

export function persistSubagentRunsToDiskOrThrow(runs: Map<string, SubagentRunRecord>) {
  saveSubagentRegistryToDisk(runs);
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

export function getSubagentRegistryReadSnapshot(): SubagentRegistryReadSnapshot {
  const shouldReadDisk = shouldReadPersistedSubagentRegistry();
  let diskSnapshot: ReturnType<typeof getSubagentRegistryDiskReadSnapshot> | null = null;
  let diskReadFailed = false;
  if (shouldReadDisk) {
    try {
      diskSnapshot = getSubagentRegistryDiskReadSnapshot();
    } catch {
      diskReadFailed = true;
    }
  }
  const diskSignature = diskSnapshot?.diskSignature ?? null;
  const memoryVersion = getSubagentRegistryMemoryVersion();
  if (
    !diskReadFailed &&
    cachedReadSnapshot?.shouldReadDisk === shouldReadDisk &&
    cachedReadSnapshot.diskSignature === diskSignature &&
    cachedReadSnapshot.memoryVersion === memoryVersion
  ) {
    return cachedReadSnapshot.snapshot;
  }

  const inMemoryEntries = [...subagentRuns.entries()].map(
    ([runId, entry]) => [runId, cloneReadonlySubagentRunRecord(entry)] as const,
  );
  const inMemoryRunsById = createReadonlySubagentRunMap(inMemoryEntries);
  const mergedRuns = new Map<string, ReadonlySubagentRunRecord>();
  if (diskSnapshot) {
    for (const [runId, entry] of diskSnapshot.runsById.entries()) {
      mergedRuns.set(runId, entry);
    }
  }
  for (const [runId, entry] of inMemoryRunsById.entries()) {
    mergedRuns.set(runId, entry);
  }

  const snapshot = Object.freeze({
    source: "subagent-registry" as const,
    diskSignature,
    memoryVersion,
    runsById: createReadonlySubagentRunMap(mergedRuns.entries()),
    inMemoryRunsById,
  });
  if (!diskReadFailed) {
    cachedReadSnapshot = {
      shouldReadDisk,
      diskSignature,
      memoryVersion,
      snapshot,
    };
  }
  return snapshot;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk = shouldReadPersistedSubagentRegistry();
  if (shouldReadDisk) {
    try {
      // Persisted state lets other worker processes observe active runs.
      for (const [runId, entry] of loadSubagentRegistryFromDisk({ clone: false }).entries()) {
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
