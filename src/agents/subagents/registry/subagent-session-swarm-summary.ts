import type { SessionRow } from "../../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";

const MAX_ACTIVE_GROUPS = 4;
type SwarmSummary = NonNullable<SessionRow["swarm"]>;
type Member = NonNullable<SwarmSummary["groups"][number]["children"]>[number];
type Group = SwarmSummary["groups"][number] & { members?: Array<Member & { createdAt: number }> };
const STATUS_RANK = { running: 0, queued: 1, failed: 2, done: 3 } as const;

/** Counts requester-owned operations, including tombstones whose child sessions were deleted. */
export function buildSessionSwarmSummary(
  runs: readonly SubagentRunReadRecord[],
  sessionKey: string,
  agentId: string,
  options: { includeChildren?: boolean } = {},
): SwarmSummary | undefined {
  const groups = new Map<string, Group>();
  for (const run of runs) {
    if (
      !run.collect ||
      !run.groupId ||
      run.swarmRequesterSessionKey !== sessionKey ||
      run.requesterAgentId !== agentId
    ) {
      continue;
    }
    const group: Group = groups.get(run.groupId) ?? {
      groupId: run.groupId,
      createdAt: run.createdAt,
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      ...(options.includeChildren ? { members: [] } : {}),
    };
    group.createdAt = Math.min(group.createdAt, run.createdAt);
    // Completion is frozen by the collector owner only after its result settles.
    // A provider terminal event alone must not claim the collector has finished.
    const completion = run.collectorCompletion?.status;
    const status = completion
      ? completion === "done"
        ? "done"
        : "failed"
      : run.execution.status === "queued"
        ? "queued"
        : "running";
    group[status] += 1;
    groups.set(run.groupId, group);
    group.members?.push({ sessionKey: run.childSessionKey, status, createdAt: run.createdAt });
  }
  if (groups.size === 0) {
    return undefined;
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- The spread creates a private group array.
  const ordered = [...groups.values()].sort(
    (left, right) => right.createdAt - left.createdAt || left.groupId.localeCompare(right.groupId),
  );
  const active = ordered.filter((group) => group.queued + group.running > 0);
  const terminal = ordered.find((group) => group.queued + group.running === 0);
  const selected = [...active.slice(0, MAX_ACTIVE_GROUPS), ...(terminal ? [terminal] : [])];
  if (options.includeChildren) {
    // Only a selected-parent read carries member detail; ordinary rosters stay compact.
    for (const group of selected) {
      group.children = group.members
        // oxlint-disable-next-line unicorn/no-array-sort -- Member arrays are private to this summary invocation.
        ?.sort(
          (left, right) =>
            STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
            left.createdAt - right.createdAt ||
            left.sessionKey.localeCompare(right.sessionKey),
        )
        .slice(0, 64)
        .map(({ sessionKey: childKey, status }) => ({ sessionKey: childKey, status }));
      delete group.members;
    }
  }
  return {
    groups: selected,
    otherActiveGroups: Math.max(0, active.length - MAX_ACTIVE_GROUPS),
  };
}
