import { isDeepStrictEqual } from "node:util";
import { immutableSubagentRunSessionList, subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  buildLatestSubagentRunReadIndexFromRuns,
  buildSubagentRunReadIndexFromRuns,
  type LatestSubagentRunReadIndex,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import type { SubagentRunReadSelection } from "./subagent-registry-read-snapshot.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  withSubagentRunReadSnapshot,
  type SubagentSessionListReadView,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner, isSameSubagentRunOwner } from "./subagent-run-generation.js";

function captureRuntimeOwner(entry: SubagentRunRecord): SubagentRunReadRecord {
  // Display facts never acquire authority; only this separate copy retains its live owner.
  return copySubagentRunRuntimeOwner(
    entry,
    Object.freeze({ ...immutableSubagentRunSessionList(entry) }),
  );
}

/** Capture only runtime owners selected by this projection, in the consuming frame. */
export function captureSubagentSessionListReadIndex(
  runs: Map<string, SubagentRunReadRecord>,
  now = Date.now(),
  residentRuns: Iterable<SubagentRunRecord> = [...runs.keys()].flatMap((id) => {
    const entry = subagentRuns.get(id);
    return entry ? [entry] : [];
  }),
): SubagentRunReadIndex<SubagentRunReadRecord> {
  return buildSubagentRunReadIndexFromRuns({
    runs,
    inMemoryRuns: Array.from(residentRuns, captureRuntimeOwner),
    now,
  });
}

/** One prepared projection supplies compact topology, selected payloads and current liveness. */
export function withSubagentSessionListRead<S extends SubagentRunReadSelection, T>(
  sessionKeys: readonly string[],
  select: (latest: LatestSubagentRunReadIndex<SubagentRunReadRecord>) => S,
  consume: (
    selection: S,
    runs: ReadonlyMap<string, SubagentRunRecord>,
    readIndex: () => SubagentRunReadIndex<SubagentRunReadRecord>,
  ) => T,
): Promise<T> {
  return withSubagentRunReadSnapshot(
    subagentRuns,
    (snapshot) => {
      const selection = select(buildLatestSubagentRunReadIndexFromRuns(snapshot));
      return { snapshot, selection, runIds: selection.runIds, sessionKeys: selection.sessionKeys };
    },
    ({ snapshot, selection }, runs) =>
      consume(selection, runs, () => captureSubagentSessionListReadIndex(snapshot)),
    { sessionKeys, descendants: true },
  );
}

/** A resident list index consumes keyed publications until its source is replaced. */
export function createSubagentSessionListReadIndex(
  source: SubagentSessionListReadView,
  now: number,
) {
  let identity = source.snapshotIdentity();
  let memory = new Map(Array.from(subagentRuns, ([id, entry]) => [id, captureRuntimeOwner(entry)]));
  let index = buildSubagentRunReadIndexFromRuns({
    runs: source.runs(),
    inMemoryRuns: memory.values(),
    now,
  });
  let revision = 0;
  let replaced = false;
  const changedChildren = new Set<string>();
  const changedSwarmRequesters = new Set<string>();
  const pending = new Set<string>();
  const dispose = subscribeSubagentRunChanges("projection", ({ runIds: ids }) => {
    if (!ids) {
      replaced = true;
    } else {
      for (const id of ids) {
        pending.add(id);
      }
    }
  });
  return {
    dispose,
    changedChildren,
    changedSwarmRequesters,
    get revision() {
      return revision;
    },
    read(clock: number) {
      changedChildren.clear();
      changedSwarmRequesters.clear();
      const nextIdentity = source.snapshotIdentity();
      if (replaced || identity !== nextIdentity) {
        for (const key of index.swarmRunsByRequesterSessionKey.keys()) {
          changedSwarmRequesters.add(key);
        }
        for (const key of index.runsByChildSessionKey.keys()) {
          changedChildren.add(key);
        }
        memory = new Map(
          Array.from(subagentRuns, ([id, entry]) => [id, captureRuntimeOwner(entry)]),
        );
        index = buildSubagentRunReadIndexFromRuns({
          runs: source.runs(),
          inMemoryRuns: memory.values(),
          now: clock,
        });
        for (const key of index.runsByChildSessionKey.keys()) {
          changedChildren.add(key);
        }
        for (const key of index.swarmRunsByRequesterSessionKey.keys()) {
          changedSwarmRequesters.add(key);
        }
        revision++;
      } else if (pending.size) {
        const rows = source.runs(pending);
        const changes = new Map<string, SubagentRunReadRecord | undefined>();
        const owners = new Map<string, SubagentRunReadRecord | undefined>();
        for (const id of pending) {
          const row = rows.get(id);
          const resident = subagentRuns.get(id);
          const owner = resident && captureRuntimeOwner(resident);
          const previousOwner = memory.get(id);
          const sameOwner = previousOwner === owner || isSameSubagentRunOwner(previousOwner, owner);
          if (!sameOwner || !isDeepStrictEqual(index.inputs.runs.get(id), row)) {
            for (const entry of [index.inputs.runs.get(id), row]) {
              if (entry) {
                changedChildren.add(entry.childSessionKey.trim());
                if (entry.swarmRequesterSessionKey) {
                  changedSwarmRequesters.add(entry.swarmRequesterSessionKey);
                }
              }
            }
            changes.set(id, row);
            owners.set(id, owner);
            if (owner) {
              memory.set(id, owner);
            } else {
              memory.delete(id);
            }
          }
        }
        if (changes.size) {
          index = index.patch(changes, owners, clock);
          revision++;
        }
      }
      identity = nextIdentity;
      replaced = false;
      pending.clear();
      return index.atTime(clock);
    },
  };
}
