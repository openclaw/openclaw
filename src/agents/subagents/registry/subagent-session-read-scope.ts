import type { SubagentRunReadRecord } from "./subagent-registry.types.js";

type RunIdentity = Pick<SubagentRunReadRecord, "childSessionKey" | "requesterSessionKey">;

/** Select a complete requester closure; the read index still owns generation and liveness policy. */
export function collectSubagentSessionReadKeys(
  sessionKeys: readonly string[],
  ...runGroups: Iterable<RunIdentity>[]
): Set<string> {
  const selected = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
  const children = new Map<string, Set<string>>();
  for (const runs of runGroups) {
    for (const run of runs) {
      const child = run.childSessionKey.trim();
      if (!child) {
        continue;
      }
      const siblings = children.get(run.requesterSessionKey) ?? new Set<string>();
      siblings.add(child);
      children.set(run.requesterSessionKey, siblings);
    }
  }
  // Traverse all generations, including superseded edges. This superset preserves
  // the index's global latest-child veto without reading retained payloads first.
  for (const requester of selected) {
    for (const child of children.get(requester) ?? []) {
      selected.add(child);
    }
  }
  return selected;
}
