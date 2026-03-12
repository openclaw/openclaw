import { getRuntimePostgresPersistencePolicySync } from "../persistence/postgres-client.js";
import {
  loadSubagentRunsFromPostgres,
  persistSubagentRegistryToPostgres,
} from "../persistence/service.js";
import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

let runtimeSubagentRunsSnapshot: Map<string, SubagentRunRecord> | null = null;
const subagentRegistryQueues = new Map<string, Promise<void>>();

function cloneSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return new Map([...runs.entries()].map(([runId, entry]) => [runId, structuredClone(entry)]));
}

export function replaceRuntimeSubagentRunsSnapshot(runs: Map<string, SubagentRunRecord>): void {
  runtimeSubagentRunsSnapshot = cloneSubagentRunsSnapshot(runs);
}

export function clearRuntimeSubagentRunsSnapshot(): void {
  runtimeSubagentRunsSnapshot = null;
}

function getRuntimeSubagentRunsSnapshot(): Map<string, SubagentRunRecord> | null {
  if (!runtimeSubagentRunsSnapshot) {
    return null;
  }
  return cloneSubagentRunsSnapshot(runtimeSubagentRunsSnapshot);
}

function runWithSubagentRegistryQueue<T>(task: () => Promise<T>): Promise<T> {
  const key = "subagent-registry";
  const previous = subagentRegistryQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const barrier = previous.catch(() => undefined).then(() => gate);
  subagentRegistryQueues.set(key, barrier);
  return previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      release();
      if (subagentRegistryQueues.get(key) === barrier) {
        subagentRegistryQueues.delete(key);
      }
    });
}

export function persistSubagentRunsToDisk(runs: Map<string, SubagentRunRecord>) {
  const policy = getRuntimePostgresPersistencePolicySync();
  if (policy.enabled) {
    replaceRuntimeSubagentRunsSnapshot(runs);
    const snapshot = cloneSubagentRunsSnapshot(runs);
    void runWithSubagentRegistryQueue(async () => {
      await persistSubagentRegistryToPostgres(
        {
          runs: cloneSubagentRunsSnapshot(snapshot),
        },
        { lookupMode: "runtime" },
      );
      if (policy.exportCompatibility) {
        saveSubagentRegistryToDisk(snapshot);
      }
    }).catch(() => {
      // Best-effort persistence; the in-memory registry remains authoritative in-process.
    });
    return;
  }
  clearRuntimeSubagentRunsSnapshot();
  try {
    saveSubagentRegistryToDisk(runs);
  } catch {
    // ignore persistence failures
  }
}

export async function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const policy = getRuntimePostgresPersistencePolicySync();
  const restored =
    (policy.enabled ? getRuntimeSubagentRunsSnapshot() : null) ??
    (policy.enabled
      ? await loadSubagentRunsFromPostgres({ lookupMode: "runtime" })
      : loadSubagentRegistryFromDisk());
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
  const policy = getRuntimePostgresPersistencePolicySync();
  const runtimeSnapshot = policy.enabled ? getRuntimeSubagentRunsSnapshot() : null;
  if (runtimeSnapshot) {
    const merged = runtimeSnapshot;
    for (const [runId, entry] of inMemoryRuns.entries()) {
      merged.set(runId, entry);
    }
    return merged;
  }
  if (policy.enabled) {
    return cloneSubagentRunsSnapshot(inMemoryRuns);
  }
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
