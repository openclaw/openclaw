import { isDeepStrictEqual } from "node:util";
import { subagentRuns } from "./subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { buildSubagentSessionListReadIndex } from "./subagent-registry-read.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentSessionListReadView } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** A resident list index consumes keyed publications until its source is replaced. */
export function createSubagentSessionListReadIndex(
  source: SubagentSessionListReadView,
  now: number,
) {
  let identity = source.snapshotIdentity();
  let index = buildSubagentSessionListReadIndex(now, undefined, source.runs());
  let memory = new Map(subagentRuns);
  let revision = 0;
  let replaced = false;
  const changedChildren = new Set<string>();
  const pending = new Set<string>();
  const dispose = subscribeSubagentRunChanges((ids) => {
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
    get revision() {
      return revision;
    },
    read(clock: number) {
      changedChildren.clear();
      const nextIdentity = source.snapshotIdentity();
      if (replaced || identity !== nextIdentity) {
        for (const key of index.runsByChildSessionKey.keys()) {
          changedChildren.add(key);
        }
        index = buildSubagentSessionListReadIndex(clock, undefined, source.runs());
        for (const key of index.runsByChildSessionKey.keys()) {
          changedChildren.add(key);
        }
        memory = new Map(subagentRuns);
        revision++;
      } else if (pending.size) {
        const rows = source.runs(pending);
        const changes = new Map<string, SubagentRunReadRecord | undefined>();
        const owners = new Map<string, SubagentRunRecord | undefined>();
        for (const id of pending) {
          const row = rows.get(id);
          const owner = subagentRuns.get(id);
          if (memory.get(id) !== owner || !isDeepStrictEqual(index.inputs.runs.get(id), row)) {
            for (const entry of [index.inputs.runs.get(id), row]) {
              if (entry) {
                changedChildren.add(entry.childSessionKey.trim());
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
