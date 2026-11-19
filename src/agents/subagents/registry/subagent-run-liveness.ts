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
    current.collect &&
    current.execution.status === "queued" &&
    isSameSubagentRunOwner(current, entry) &&
    ownsSwarmRunReservation(
      current.schedulerSlotId ?? current.runId,
      getSubagentRunRuntimeKey(current),
    ),
  );
}

// Exported for the continuation work-dispatch suites, which age runs past this cutoff.
export const STALE_UNENDED_SUBAGENT_RUN_MS = 2 * 60 * 60 * 1_000;
export const RECENT_ENDED_SUBAGENT_CHILD_SESSION_MS = 30 * 60 * 1_000;
const EXPLICIT_TIMEOUT_STALE_GRACE_MS = 60_000;
const MIN_REALISTIC_RUN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);

export function hasSubagentRunEnded<T extends { execution: { endedAt?: number } }>(
  entry: T,
): entry is T & { execution: T["execution"] & { endedAt: number } } {
  return typeof entry.execution.endedAt === "number" && Number.isFinite(entry.execution.endedAt);
}

export function isYieldedSubagentRun(entry: SubagentRunRecord): boolean {
  return (
    entry.pauseReason === "sessions_yield" &&
    !entry.killIntent &&
    !entry.killReconciliation &&
    entry.suppressAnnounceReason !== "killed" &&
    entry.endedReason !== "subagent-killed"
  );
}

/** An ended message wait owns a continuation, not a finished result. */
export function isEndedSubagentMessageWait(entry: SubagentRunRecord): boolean {
  return (
    entry.execution.status === "terminal" &&
    isYieldedSubagentRun(entry) &&
    entry.waitForMessage === true &&
    hasSubagentRunEnded(entry)
  );
}

/**
 * Last instant covered by registration grace, independent of live execution custody.
 * `defaultFloorMs` applies when the run carries no explicit timeout; the orphan-reap
 * confidence gate passes its tunable floor, and an explicit timeout plus grace is always
 * respected so such a run is never aged out early.
 */
export function getSubagentRunStaleAt(
  entry: SubagentRunLivenessRecord,
  defaultFloorMs = STALE_UNENDED_SUBAGENT_RUN_MS,
): number {
  if (hasSubagentRunEnded(entry)) {
    return Infinity;
  }
  // Creation bounds stale admission, but must not become a displayed execution start.
  const startedAt = getSubagentSessionStartedAt(entry) ?? entry.createdAt;
  if (
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    startedAt < MIN_REALISTIC_RUN_TIMESTAMP_MS
  ) {
    return Infinity;
  }
  const durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);
  const cutoffMs =
    durationMs === undefined
      ? defaultFloorMs
      : Math.max(defaultFloorMs, durationMs + EXPLICIT_TIMEOUT_STALE_GRACE_MS);
  return startedAt + cutoffMs;
}

function isStaleUnendedSubagentRun(entry: SubagentRunLivenessRecord, now = Date.now()): boolean {
  return now > getSubagentRunStaleAt(entry);
}

/**
 * Three-state liveness verdict for the orphan-reap confidence gate.
 *
 * Collapses a child-session run record into the only distinction the reaper may
 * act on: are we CONFIDENT the parent run is terminal (reap-eligible), is it
 * plausibly still live (quiesce), or do we simply not know (quiesce)? The
 * asymmetric error cost is load-bearing : wrongly culling a busy session is
 * unrecoverable, while parking a zombie is harmless — so anything short of
 * `confident-terminal` MUST resolve to a non-reap state.
 *
 * - `undefined` entry (no run record for the session) → `uncertain`: we cannot
 *   confirm the parent is gone, so never reap. A recovered or main-agent session
 *   with no child-run record lands here and is protected.
 * - explicit `endedAt` (markSubagentRunTerminated writes it synchronously on
 *   explicit termination, no lag) → `confident-terminal`.
 * - unended but aged past the (tunable) stale cutoff → `confident-terminal`: the
 *   driver died without marking, and only after the cutoff are we confident.
 * - unended within the stale window → `alive`: genuinely live, or racy-dead
 *   inside the grace — both quiesce, never reap.
 *
 * `staleCutoffMs` is the operator-tunable confidence-gate floor; the per-run
 * timeout-derived cutoff is always respected (see getSubagentRunStaleAt).
 */
export type SubagentRunLiveness = "alive" | "confident-terminal" | "uncertain";

export function classifySubagentRunLiveness(
  entry: SubagentRunLivenessRecord | undefined,
  options: { now?: number; staleCutoffMs?: number } = {},
): SubagentRunLiveness {
  if (!entry) {
    return "uncertain";
  }
  if (hasSubagentRunEnded(entry)) {
    return "confident-terminal";
  }
  const now = options.now ?? Date.now();
  const floorMs = options.staleCutoffMs ?? STALE_UNENDED_SUBAGENT_RUN_MS;
  return now > getSubagentRunStaleAt(entry, floorMs) ? "confident-terminal" : "alive";
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
