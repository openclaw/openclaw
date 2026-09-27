import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import { latestSubagentRun, recordLatestSubagentRun } from "./subagent-run-generation.js";

export function resolveControllerSessionKey(
  entry: Pick<SubagentRunReadRecord, "controllerSessionKey" | "requesterSessionKey">,
): string {
  return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
}

/** Mutable membership belongs to the resident index; query windows own time and liveness. */
export function buildSubagentRunReadTopology<T extends SubagentRunReadRecord>(params: {
  runs: Map<string, T>;
  inMemoryRuns?: Iterable<T>;
}) {
  const { runs } = params;
  const inMemoryDisplayByChildSessionKey = new Map<string, T>();
  const runsByChildSessionKey = new Map<string, T[]>();
  const latestRunsByChildSessionKey = new Map<string, T>();
  const runsByControllerSessionKey = new Map<string, T[]>();
  const swarmRunsByRequesterSessionKey = new Map<string, T[]>();
  const latestRunByRequesterAndChildSessionKey = new Map<string, Map<string, T>>();
  const snapshotRunsByChildSessionKey = new Map<string, T[]>();
  const memoryRunsByChildSessionKey = new Map<string, T[]>();
  const memoryChildKeys = new Map<string, string>();
  const runKeys = new Map<string, string[]>();
  const groupingKeys = (entry: T) => [
    entry.childSessionKey.trim(),
    resolveControllerSessionKey(entry),
    entry.collect && entry.groupId ? (entry.swarmRequesterSessionKey ?? "") : "",
    entry.requesterSessionKey,
  ];
  const updateBucket = (
    index: Map<string, T[]>,
    key: string,
    runId: string,
    entry?: T,
    replace = true,
  ) => {
    if (!key) {
      return;
    }
    const rows = index.get(key) ?? [];
    const position = replace ? rows.findIndex((row) => row.runId === runId) : -1;
    if (position >= 0) {
      rows.splice(position, 1, ...(entry ? [entry] : []));
    } else if (entry) {
      rows.push(entry);
    }
    if (rows.length) {
      index.set(key, rows);
    } else {
      index.delete(key);
    }
  };

  for (const entry of params.inMemoryRuns ?? []) {
    const childSessionKey = entry.childSessionKey.trim();
    memoryChildKeys.set(entry.runId, childSessionKey);
    updateBucket(memoryRunsByChildSessionKey, childSessionKey, entry.runId, entry, false);
    if (!childSessionKey) {
      continue;
    }
    recordLatestSubagentRun(inMemoryDisplayByChildSessionKey, childSessionKey, entry);
  }

  const inputs = {
    runs,
    inMemoryRuns: new Set(inMemoryDisplayByChildSessionKey.values()),
  };
  function patch(
    changes: ReadonlyMap<string, T | undefined>,
    inMemoryChanges: ReadonlyMap<string, T | undefined>,
  ): void {
    const affected = new Map<string, Set<string>>();
    const touch = (child: string) => {
      if (child && !affected.has(child)) {
        affected.set(
          child,
          new Set(
            (snapshotRunsByChildSessionKey.get(child) ?? []).map(
              (entry) => runKeys.get(entry.runId)?.[3] ?? entry.requesterSessionKey,
            ),
          ),
        );
      }
    };
    const groups = [
      snapshotRunsByChildSessionKey,
      runsByControllerSessionKey,
      swarmRunsByRequesterSessionKey,
    ];
    for (const [runId, entry] of changes) {
      const previous = runKeys.get(runId) ?? [];
      const next = entry ? groupingKeys(entry) : [];
      touch(previous[0] ?? "");
      touch(next[0] ?? "");
      groups.forEach((index, position) => {
        if (previous[position] && previous[position] !== next[position]) {
          updateBucket(index, previous[position], runId);
        }
        updateBucket(
          index,
          next[position] ?? "",
          runId,
          entry,
          previous[position] === next[position],
        );
      });
      if (entry) {
        // Initialization reads the caller's Map; only patches write new facts.
        if (changes !== runs) {
          runs.set(runId, entry);
        }
        runKeys.set(runId, next);
      } else {
        runs.delete(runId);
        runKeys.delete(runId);
      }
    }
    for (const [runId, entry] of inMemoryChanges) {
      const previous = memoryChildKeys.get(runId) ?? "";
      const next = entry?.childSessionKey.trim() ?? "";
      touch(previous);
      touch(next);
      if (previous !== next) {
        updateBucket(memoryRunsByChildSessionKey, previous, runId);
      }
      updateBucket(memoryRunsByChildSessionKey, next, runId, entry, previous === next);
      if (entry) {
        memoryChildKeys.set(runId, next);
      } else {
        memoryChildKeys.delete(runId);
      }
    }
    for (const [child, previousRequesters] of affected) {
      const rows = snapshotRunsByChildSessionKey.get(child) ?? [];
      const memory = latestSubagentRun(memoryRunsByChildSessionKey.get(child) ?? []);
      const latest = latestSubagentRun(rows);
      const previousMemory = inMemoryDisplayByChildSessionKey.get(child);
      if (previousMemory !== memory) {
        if (previousMemory) {
          inputs.inMemoryRuns.delete(previousMemory);
        }
        if (memory) {
          inputs.inMemoryRuns.add(memory);
        }
      }
      for (const [index, entry] of [
        [inMemoryDisplayByChildSessionKey, memory],
        [latestRunsByChildSessionKey, latest],
      ] as const) {
        if (entry) {
          index.set(child, entry);
        } else {
          index.delete(child);
        }
      }
      const candidates = [...new Set([...rows, ...(memory ? [memory] : [])])];
      if (candidates.length) {
        runsByChildSessionKey.set(child, candidates);
      } else {
        runsByChildSessionKey.delete(child);
      }
      const byRequester = new Map<string, T>();
      for (const row of rows) {
        if (row.requesterSessionKey) {
          recordLatestSubagentRun(byRequester, row.requesterSessionKey, row);
        }
      }
      for (const requester of new Set([...previousRequesters, ...byRequester.keys()])) {
        const children =
          latestRunByRequesterAndChildSessionKey.get(requester) ?? new Map<string, T>();
        const entry = byRequester.get(requester);
        if (entry) {
          children.set(child, entry);
        } else {
          children.delete(child);
        }
        if (children.size) {
          latestRunByRequesterAndChildSessionKey.set(requester, children);
        } else {
          latestRunByRequesterAndChildSessionKey.delete(requester);
        }
      }
    }
  }
  patch(runs, new Map());
  for (const [key, entry] of inMemoryDisplayByChildSessionKey) {
    if (!runsByChildSessionKey.has(key)) {
      runsByChildSessionKey.set(key, [entry]);
    }
  }
  return {
    inputs,
    inMemoryDisplayByChildSessionKey,
    runsByChildSessionKey,
    latestRunsByChildSessionKey,
    runsByControllerSessionKey,
    swarmRunsByRequesterSessionKey,
    latestRunByRequesterAndChildSessionKey,
    patch,
  };
}
