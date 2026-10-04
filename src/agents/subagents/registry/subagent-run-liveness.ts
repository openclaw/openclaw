/**
 * Subagent run liveness policy.
 *
 * Ages out stale unended runs while keeping recent/composed child links visible.
 */
import { hasLiveAgentRunContext } from "../../../infra/agent-run-registry.js";
import { ownsSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
  type SubagentRunIdentity,
} from "./subagent-run-generation.js";
import { resolveSubagentRunDurationMs } from "./subagent-run-timeout.js";
import { getSubagentSessionStartedAt } from "./subagent-session-metrics.js";

type SubagentRunLivenessRecord = Pick<
  SubagentRunRecord,
  "createdAt" | "sessionStartedAt" | "runTimeoutSeconds"
> & {
  execution: Pick<SubagentRunRecord["execution"], "startedAt" | "endedAt">;
};

/** Routing metadata alone does not own an execution. */
export function isSubagentRunLive(
  entry:
    | (SubagentRunIdentity & { execution: Pick<SubagentRunRecord["execution"], "endedAt"> })
    | null
    | undefined,
): boolean {
  if (!entry || typeof entry.execution.endedAt === "number") {
    return false;
  }
  const current = subagentRuns.get(entry.runId);
  return Boolean(
    current &&
    typeof current.execution.endedAt !== "number" &&
    isSameSubagentRunOwner(current, entry) &&
    hasLiveAgentRunContext(entry.runId),
  );
}

/** Queued admission belongs to the exact current registration and scheduler reservation. */
export function isSubagentRunQueued(entry: SubagentRunIdentity | null | undefined): boolean {
  const current = entry ? subagentRuns.get(entry.runId) : undefined;
  return Boolean(
    current &&
    isSameSubagentRunOwner(current, entry) &&
    current.collect &&
    current.execution.status === "queued" &&
    ownsSwarmRunReservation(
      current.schedulerSlotId ?? current.runId,
      getSubagentRunRuntimeKey(current),
    ),
  );
}

const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;
export const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS = 30 * 60 * 1_000;
const EXPLICIT_TIMEOUT_STALE_GRACE_MS = 60_000;
const MIN_REALISTIC_RUN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

/** Return whether a subagent run has a finite execution end timestamp. */
export function hasSubagentRunEnded<T extends { execution: { endedAt?: number } }>(
  entry: T,
): entry is T & { execution: T["execution"] & { endedAt: number } } {
  return typeof entry.execution.endedAt === "number" && Number.isFinite(entry.execution.endedAt);
}

function resolveStaleCutoffMs(entry: Pick<SubagentRunRecord, "runTimeoutSeconds">): number {
  const durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);
  if (durationMs !== undefined) {
    return Math.max(STALE_UNENDED_SUBAGENT_RUN_MS, durationMs + EXPLICIT_TIMEOUT_STALE_GRACE_MS);
  }
  return STALE_UNENDED_SUBAGENT_RUN_MS;
}

/** Return whether an unended subagent run is stale enough to hide as inactive. */
export function isStaleUnendedSubagentRun(
  entry: SubagentRunLivenessRecord,
  now = Date.now(),
): boolean {
  if (hasSubagentRunEnded(entry)) {
    return false;
  }
  // Creation bounds stale admission, but must not become a displayed execution start.
  const startedAt = getSubagentSessionStartedAt(entry) ?? entry.createdAt;
  if (
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    startedAt < MIN_REALISTIC_RUN_TIMESTAMP_MS
  ) {
    return false;
  }
  return now - startedAt > resolveStaleCutoffMs(entry);
}

/** Admission/display retention includes current owners and a bounded registration grace.
 * This is not an executor-liveness assertion; use isSubagentRunLive for that.
 */
export function isRetainedUnendedSubagentRun(
  entry: SubagentRunLivenessRecord & { runId: string },
  now = Date.now(),
): boolean {
  return (
    !hasSubagentRunEnded(entry) &&
    (isSubagentRunLive(entry) ||
      isSubagentRunQueued(entry) ||
      !isStaleUnendedSubagentRun(entry, now))
  );
}

/** Return whether a child-session link should still appear in subagent listings. */
export function shouldKeepSubagentRunChildLink(
  entry: SubagentRunLivenessRecord & { runId: string },
  options?: {
    activeDescendants?: number;
    now?: number;
  },
): boolean {
  const now = options?.now ?? Date.now();
  return (
    isRetainedUnendedSubagentRun(entry, now) ||
    (options?.activeDescendants ?? 0) > 0 ||
    (hasSubagentRunEnded(entry) &&
      now - entry.execution.endedAt <= RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS)
  );
}
