import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  compareSubagentRunGeneration,
  latestSubagentRun,
  recordLatestSubagentRun,
} from "./subagent-run-generation.js";

const NO_DESCENDANTS: readonly never[] = Object.freeze([]);

type RunMembership = {
  keys: string[];
  snapshotPosition: number | undefined;
  controllerPosition: number | undefined;
  swarmPosition: number | undefined;
  memoryPosition: number | undefined;
  // Live entries can move in place before their patch reaches this index.
  memoryChildKey: string | undefined;
};
type PositionKey = Exclude<keyof RunMembership, "keys" | "memoryChildKey">;

function updateIndex<T>(index: Map<string, T>, key: string, value: T | undefined): void {
  if (value === undefined) {
    index.delete(key);
  } else {
    index.set(key, value);
  }
}

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
  const descendantsBySessionKey = new Map<string, readonly string[]>();
  let revision = {};
  const snapshotRunsByChildSessionKey = new Map<string, T[]>();
  const memoryRunsByChildSessionKey = new Map<string, T[]>();
  const memberships = new Map<string, RunMembership>();
  const membershipFor = (runId: string): RunMembership => {
    let membership = memberships.get(runId);
    if (!membership) {
      membership = {
        keys: [],
        snapshotPosition: undefined,
        controllerPosition: undefined,
        swarmPosition: undefined,
        memoryPosition: undefined,
        memoryChildKey: undefined,
      };
      memberships.set(runId, membership);
    }
    return membership;
  };
  const groupingKeys = (entry: T) => [
    entry.childSessionKey.trim(),
    resolveControllerSessionKey(entry),
    entry.collect && entry.groupId ? (entry.swarmRequesterSessionKey ?? "") : "",
    entry.requesterSessionKey,
  ];
  const updateBucket = (
    index: Map<string, T[]>,
    positionKey: PositionKey,
    key: string,
    runId: string,
    entry?: T,
  ) => {
    if (!key) {
      return;
    }
    let rows = index.get(key) ?? [];
    if (index === snapshotRunsByChildSessionKey && runsByChildSessionKey.get(key) === rows) {
      // Published child groups remain stable while the owner patches its next generation.
      rows = rows.slice();
    }
    const membership = membershipFor(runId);
    const position = membership[positionKey];
    if (position !== undefined) {
      if (entry) {
        rows[position] = entry;
      } else {
        rows.splice(position, 1);
        membership[positionKey] = undefined;
        // Preserve published group order and repair only positions shifted by removal.
        for (let next = position; next < rows.length; next++) {
          const row = rows[next];
          if (row) {
            memberships.get(row.runId)![positionKey] = next;
          }
        }
      }
    } else if (entry) {
      membership[positionKey] = rows.length;
      rows.push(entry);
    }
    updateIndex(index, key, rows.length ? rows : undefined);
  };

  for (const entry of params.inMemoryRuns ?? []) {
    const childSessionKey = entry.childSessionKey.trim();
    membershipFor(entry.runId).memoryChildKey = childSessionKey;
    updateBucket(
      memoryRunsByChildSessionKey,
      "memoryPosition",
      childSessionKey,
      entry.runId,
      entry,
    );
    if (!childSessionKey) {
      continue;
    }
    recordLatestSubagentRun(inMemoryDisplayByChildSessionKey, childSessionKey, entry);
  }

  const inputs = {
    runs,
    inMemoryRuns: new Set(inMemoryDisplayByChildSessionKey.values()),
  };
  const groups = [
    [snapshotRunsByChildSessionKey, "snapshotPosition"],
    [runsByControllerSessionKey, "controllerPosition"],
    [swarmRunsByRequesterSessionKey, "swarmPosition"],
  ] as const;
  function patch(
    changes: ReadonlyMap<string, T | undefined>,
    inMemoryChanges: ReadonlyMap<string, T | undefined>,
  ): { affected: Iterable<string>; membershipChanged: boolean } {
    revision = {};
    let membershipChanged = false;
    const affected = new Map<string, Set<string>>();
    const touch = (child: string) => {
      if (child && !affected.has(child)) {
        affected.set(
          child,
          new Set(
            (snapshotRunsByChildSessionKey.get(child) ?? []).map(
              (entry) => memberships.get(entry.runId)?.keys[3] ?? entry.requesterSessionKey,
            ),
          ),
        );
      }
    };
    for (const [runId, entry] of changes) {
      const membership = membershipFor(runId);
      const previous = membership.keys;
      const next = entry ? groupingKeys(entry) : [];
      const previousPosition = membership.snapshotPosition;
      const observed =
        previousPosition === undefined
          ? undefined
          : snapshotRunsByChildSessionKey.get(previous[0] ?? "")?.[previousPosition];
      if (
        !observed ||
        !entry ||
        compareSubagentRunGeneration(observed, entry) !== 0 ||
        previous.length !== next.length ||
        previous.some((key, position) => key !== next[position])
      ) {
        descendantsBySessionKey.clear();
        membershipChanged = true;
      }
      touch(previous[0] ?? "");
      touch(next[0] ?? "");
      groups.forEach(([index, positionKey], position) => {
        if (previous[position] && previous[position] !== next[position]) {
          updateBucket(index, positionKey, previous[position], runId);
        }
        updateBucket(index, positionKey, next[position] ?? "", runId, entry);
      });
      membership.keys = next;
      if (entry) {
        // Initialization reads the caller's Map; only patches write new facts.
        if (changes !== runs) {
          runs.set(runId, entry);
        }
      } else {
        runs.delete(runId);
        if (membership.memoryChildKey === undefined) {
          memberships.delete(runId);
        }
      }
    }
    for (const [runId, entry] of inMemoryChanges) {
      const membership = membershipFor(runId);
      const previous = membership.memoryChildKey ?? "";
      const next = entry?.childSessionKey.trim() ?? "";
      touch(previous);
      touch(next);
      if (previous !== next) {
        updateBucket(memoryRunsByChildSessionKey, "memoryPosition", previous, runId);
      }
      updateBucket(memoryRunsByChildSessionKey, "memoryPosition", next, runId, entry);
      membership.memoryChildKey = entry ? next : undefined;
      if (!entry && !membership.keys.length) {
        memberships.delete(runId);
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
        updateIndex(index, child, entry);
      }
      const candidates = memory && !rows.includes(memory) ? [...rows, memory] : rows;
      if (candidates !== rows && runsByChildSessionKey.get(child) === rows) {
        // A memory-only overlay can retire a shared array before the next durable patch.
        snapshotRunsByChildSessionKey.set(child, rows.slice());
      }
      updateIndex(runsByChildSessionKey, child, candidates.length ? candidates : undefined);
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
        updateIndex(children, child, entry);
        updateIndex(
          latestRunByRequesterAndChildSessionKey,
          requester,
          children.size ? children : undefined,
        );
      }
    }
    return { affected: affected.keys(), membershipChanged };
  }
  patch(runs, new Map());
  for (const [key, entry] of inMemoryDisplayByChildSessionKey) {
    if (!runsByChildSessionKey.has(key)) {
      runsByChildSessionKey.set(key, [entry]);
    }
  }
  function getDescendantKeys(rootSessionKey: string): readonly string[] {
    const root = rootSessionKey.trim();
    if (!root || !latestRunByRequesterAndChildSessionKey.has(root)) {
      return NO_DESCENDANTS;
    }
    const cached = descendantsBySessionKey.get(root);
    if (cached) {
      return cached;
    }
    const descendants: string[] = [];
    const pending = [root];
    const visited = new Set(pending);
    for (const requester of pending) {
      for (const [childSessionKey, entry] of latestRunByRequesterAndChildSessionKey.get(
        requester,
      ) ?? []) {
        // Superseded generations cannot keep their former parent's descendants alive.
        if (latestRunsByChildSessionKey.get(childSessionKey) !== entry) {
          continue;
        }
        // Status updates retain membership; child keys resolve rows from the retained index.
        descendants.push(childSessionKey);
        if (!visited.has(childSessionKey)) {
          visited.add(childSessionKey);
          pending.push(childSessionKey);
        }
      }
    }
    descendantsBySessionKey.set(root, Object.freeze(descendants));
    return descendants;
  }
  return {
    inputs,
    get revision() {
      return revision;
    },
    getDescendantKeys,
    inMemoryDisplayByChildSessionKey,
    runsByChildSessionKey,
    latestRunsByChildSessionKey,
    runsByControllerSessionKey,
    swarmRunsByRequesterSessionKey,
    patch,
  };
}
