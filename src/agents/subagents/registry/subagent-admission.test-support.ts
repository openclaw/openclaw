import { resolveRecordedRequester } from "./subagent-child-owner-match.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import { resolveControllerSessionKey } from "./subagent-registry-read-topology.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { recordLatestSubagentRun } from "./subagent-run-generation.js";
import { isRetainedUnendedSubagentRun } from "./subagent-run-liveness.js";

/** Frozen pre-index admission algorithm for differential proof and the benchmark control. */
export function countAdmissionBefore(
  persisted: ReadonlyMap<string, SubagentRunReadRecord>,
  live: ReadonlyMap<string, SubagentRunRecord>,
  session: string,
  options?: { collect?: boolean; requesterAgentId?: string },
): number {
  const runs = new Map(persisted);
  for (const [id, entry] of live) {
    runs.set(id, entry);
  }
  const key = session.trim();
  if (!key) {
    return 0;
  }
  const now = Date.now();
  const latest = new Map<string, SubagentRunReadRecord>();
  for (const entry of runs.values()) {
    if (options?.collect !== undefined && (entry.collect === true) !== options.collect) {
      continue;
    }
    const owner = entry.collect
      ? entry.swarmRequesterSessionKey?.trim() || resolveControllerSessionKey(entry)
      : resolveControllerSessionKey(entry);
    if (
      owner !== key ||
      (options?.requesterAgentId && resolveRecordedRequester(entry) !== options.requesterAgentId)
    ) {
      continue;
    }
    recordLatestSubagentRun(latest, entry.childSessionKey, entry);
  }
  let index: ReturnType<typeof buildSubagentRunReadIndexFromRuns> | undefined;
  let count = 0;
  for (const entry of latest.values()) {
    if (isRetainedUnendedSubagentRun(entry)) {
      count++;
      continue;
    }
    index ??= buildSubagentRunReadIndexFromRuns({ runs, now });
    if (
      index.countPendingDescendantRuns(entry.childSessionKey, { excludeSettledDelivery: true }) > 0
    ) {
      count++;
    }
  }
  return count;
}

export function admissionFixture(owners = 800, now = Date.now()) {
  const persisted = new Map<string, SubagentRunRecord>();
  const live = new Map<string, SubagentRunRecord>();
  const sessions = new Set<string>();
  for (let owner = 0; owner < owners; owner++) {
    const session = `owner-${owner}`;
    sessions.add(session);
    for (let child = 0; child < 20; child++) {
      const runId = `${owner}-${child}`;
      const entry: SubagentRunRecord = {
        runId,
        childSessionKey: `child-${runId}`,
        requesterSessionKey: session,
        controllerSessionKey: child % 3 === 0 ? `controller-${owner}` : session,
        requesterDisplayKey: session,
        requesterAgentId: child % 2 ? "main" : "research",
        collect: child % 3 === 0,
        // No group is required by admission, unlike the swarm display index.
        swarmRequesterSessionKey: child % 3 === 0 ? ` ${session} ` : undefined,
        task: "synthetic admission workload",
        cleanup: "keep",
        completion: { required: false },
        delivery: { status: "not_required" },
        generation: 1,
        createdAt: now - 1000,
        execution:
          child % 4 === 0
            ? { status: "terminal", endedAt: now - 500 }
            : { status: "running", startedAt: now - (child === 19 ? 10_000_000 : 1000) },
        cleanupCompletedAt: child % 4 === 0 ? now - 400 : undefined,
      };
      persisted.set(runId, entry);
      if (child % 5 === 0) {
        live.set(runId, { ...entry, controllerSessionKey: `moved-${owner}`, collect: false });
      }
      if (child % 4 === 0) {
        const descendant: SubagentRunRecord = {
          ...entry,
          runId: `desc-${runId}`,
          childSessionKey: `desc-${runId}`,
          requesterSessionKey: entry.childSessionKey,
          controllerSessionKey: entry.childSessionKey,
          collect: false,
          execution: { status: "terminal", endedAt: now - 100 },
          cleanupCompletedAt: undefined,
          delivery: { status: child % 8 === 0 ? "pending" : "suspended" },
        };
        persisted.set(descendant.runId, descendant);
        if (child === 8) {
          // A different run generation globally vetoes this former requester's edge.
          live.set(`new-${runId}`, {
            ...descendant,
            runId: `new-${runId}`,
            generation: 2,
            requesterSessionKey: `moved-${owner}`,
            controllerSessionKey: `moved-${owner}`,
          });
        }
      }
      if (child === 18) {
        live.set(`only-${runId}`, {
          ...entry,
          runId: `only-${runId}`,
          childSessionKey: `only-${runId}`,
        });
      }
    }
  }
  for (const entry of [...persisted.values(), ...live.values()]) {
    for (const key of [
      entry.childSessionKey,
      entry.requesterSessionKey,
      entry.controllerSessionKey,
      entry.swarmRequesterSessionKey,
    ]) {
      if (key) {
        sessions.add(key.trim());
      }
    }
  }
  return { persisted, live, sessions };
}
