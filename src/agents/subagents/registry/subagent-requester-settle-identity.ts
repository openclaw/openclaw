import { isDeepStrictEqual } from "node:util";
import { buildAnnounceIdempotencyKey } from "../../announce-idempotency.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { RequesterSettleWakeState, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  isSameSubagentRun,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";

/** One owed continuation keeps one identity: its reservation, idempotency key, and recovery receipt. */
export function buildRequesterSettleWakeIdentity(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  batchRunIds: readonly string[];
  rearmGeneration?: number;
  pause?: boolean;
  retainedWake?: Pick<RequesterSettleWakeState, "attemptCount" | "yieldedFinalDeliverable"> &
    Partial<Pick<RequesterSettleWakeState, "status" | "nextAttemptAt">>;
  hasPrivateCompletion?: boolean;
}): { batchKey: string; runId: string; retainedRunId?: string } {
  const batchKey = [
    `requester-settle:${params.requesterAgentId ?? "unknown"}:${params.requesterSessionKey}:${params.batchRunIds.toSorted().join(",")}`,
    params.rearmGeneration === undefined ? undefined : `yield-${params.rearmGeneration}`,
    params.pause ? "pause" : undefined,
  ]
    .filter(Boolean)
    .join(":");
  const previousAttempt = Math.max(0, (params.retainedWake?.attemptCount ?? 0) - 1);
  const nextAttempt =
    params.retainedWake?.status === "pending" && params.retainedWake.nextAttemptAt !== undefined;
  const separateAttempts =
    params.pause ||
    !params.hasPrivateCompletion ||
    params.retainedWake?.yieldedFinalDeliverable === true;
  const attemptRunId = (attempt: number) =>
    buildAnnounceIdempotencyKey(
      separateAttempts && attempt > 0 ? `${batchKey}:retry-${attempt}` : batchKey,
    );
  const runId = attemptRunId(
    nextAttempt ? (params.retainedWake?.attemptCount ?? 0) : previousAttempt,
  );
  // A known nondelivery admits a fresh continuation; Stop still recognizes the last attempt.
  const previousRunId = attemptRunId(previousAttempt);
  const retainedRunId = nextAttempt && previousRunId !== runId ? previousRunId : undefined;
  return { batchKey, runId, retainedRunId };
}

/** True when this run is the continuation turn that delivers the row's owed batch. */
export function isRequesterSettleWakeForRun(params: {
  entry: SubagentRunRecord;
  runId: string;
  requesterSessionKey: string;
  requesterAgentId?: string;
  runsById: ReadonlyMap<string, SubagentRunRecord>;
}): boolean {
  const { entry, requesterSessionKey, requesterAgentId } = params;
  const wake = entry.requesterSettleWake;
  if (!wake) {
    return false;
  }
  const pauseNotice = entry.pauseReason === "sessions_yield" && wake.pauseNotice;
  // Dispatch selects the surviving members of its frozen generation. Retired
  // rows no longer contribute to the admitted wake's identity.
  const batchRunIds = pauseNotice
    ? [entry.runId]
    : wake.batchRunIds?.filter((id) => {
        const member = params.runsById.get(id);
        return (
          member?.requesterSettleWake !== undefined &&
          member.requesterSessionKey === entry.requesterSessionKey &&
          member.requesterAgentId === entry.requesterAgentId &&
          member.requesterStorePath === entry.requesterStorePath &&
          member.requesterSettleWake.rearmGeneration === wake.rearmGeneration
        );
      });
  if (
    entry.requesterSessionKey !== requesterSessionKey ||
    (entry.requesterAgentId && entry.requesterAgentId !== requesterAgentId) ||
    !isSameSubagentRun(params.runsById.get(entry.runId), entry) ||
    !batchRunIds?.includes(entry.runId)
  ) {
    return false;
  }
  const identity = buildRequesterSettleWakeIdentity({
    requesterSessionKey,
    requesterAgentId,
    batchRunIds,
    rearmGeneration: wake.rearmGeneration,
    pause: Boolean(pauseNotice),
    retainedWake: wake,
    hasPrivateCompletion: batchRunIds.some(
      (runId) => params.runsById.get(runId)?.completionTarget === "parent",
    ),
  });
  // Pending backoff still belongs to the last admitted attempt, not its next retry.
  return params.runId === (identity.retainedRunId ?? identity.runId);
}

/** Kill, suppression, and session retirement each end a row's completion obligation. */
export function isSubagentObligationRetired(entry: SubagentRunRecord): boolean {
  return (
    entry.killIntent !== undefined ||
    entry.killReconciliation !== undefined ||
    entry.suppressCompletionDelivery === true ||
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED
  );
}

/** A requester cohort counts only members that still owe their completion. */
export function owesRequesterCompletion(entry: SubagentRunRecord): boolean {
  return entry.expectsCompletionMessage === true && !isSubagentObligationRetired(entry);
}

/** Run, requester, and frozen delivery-policy bindings, distinct from wake progress. */
export function captureRequesterSettleRunIdentity(entry: SubagentRunRecord) {
  return {
    runId: entry.runId,
    createdAt: entry.createdAt,
    generation: entry.generation,
    taskRunId: entry.taskRunId,
    childSessionKey: entry.childSessionKey,
    childAgentId: entry.childAgentId,
    completionTarget: entry.completionTarget,
    requesterSessionKey: entry.requesterSessionKey,
    requesterAgentId: entry.requesterAgentId,
    requesterStorePath: entry.requesterStorePath,
    controllerSessionKey: entry.controllerSessionKey,
    controllerStorePath: entry.controllerStorePath,
    requesterTurnRunId: entry.requesterTurnRunId,
    completionRequesterSessionId: entry.completionRequesterSessionId,
    completionRequesterLifecycleRevision: entry.completionRequesterLifecycleRevision,
  };
}

export function sameRequesterSettleRunIdentity(
  left: SubagentRunRecord,
  right: SubagentRunRecord,
): boolean {
  return isDeepStrictEqual(
    captureRequesterSettleRunIdentity(left),
    captureRequesterSettleRunIdentity(right),
  );
}

/** Wake decisions retain their observed progress; retirement/presentation metadata is carried forward. */
export function captureRequesterSettleWakeProgress(entry: SubagentRunRecord) {
  const wake = entry.requesterSettleWake;
  return (
    wake && {
      status: wake.status,
      attemptCount: wake.attemptCount,
      replayCount: wake.replayCount ?? 0,
      nextAttemptAt: wake.nextAttemptAt,
      privateInput: wake.privateInput,
      lastError: wake.lastError,
      batchRunIds: wake.batchRunIds?.toSorted(),
      rearmGeneration: wake.rearmGeneration,
      requesterYieldBatch: wake.requesterYieldBatch === true,
      afterRequesterYield: wake.afterRequesterYield === true,
      yieldedFinalDeliverable: wake.yieldedFinalDeliverable === true,
      pauseNotice: wake.pauseNotice,
    }
  );
}

/** Completion custody can outlive a requester that finished without explicitly yielding. */
export function hasRequesterCompletionCohort(entry: SubagentRunRecord): boolean {
  const wake = entry.requesterSettleWake;
  return (
    wake?.requesterYieldBatch === true ||
    (wake?.rearmGeneration !== undefined && wake.batchRunIds?.includes(entry.runId) === true)
  );
}

/**
 * A newer task cannot revoke another task's exact completion custody. A
 * yield-paused run holds no result, only its continuation: a newer execution of
 * its session without its own completion audience continues it, so the pause
 * notice no longer owes a wake. A sibling that owes its own delivery is
 * independent and leaves the paused task resumable.
 */
export function isRequesterCompletionCohortCurrent(
  entry: SubagentRunRecord,
  latestForSession: (
    sessionKey: string,
    matches?: (candidate: SubagentRunRecord) => boolean,
    childAgentId?: string,
  ) => SubagentRunRecord | null,
): boolean {
  const taskRunId = entry.taskRunId ?? entry.runId;
  const paused = entry.pauseReason === "sessions_yield";
  const owner = latestForSession(
    entry.childSessionKey,
    (candidate) =>
      (candidate.taskRunId ?? candidate.runId) === taskRunId ||
      (paused && candidate.expectsCompletionMessage !== true),
    entry.childAgentId,
  );
  return (
    entry.killReconciliation?.supersededAt === undefined &&
    (!owner || compareSubagentRunGeneration(owner, entry) <= 0)
  );
}

const requesterRetirementCustody = (current: SubagentRunRecord) => ({
  requester: captureRequesterSettleRunIdentity(current),
  expectsCompletionMessage: current.expectsCompletionMessage === true,
  suppressCompletionDelivery: current.suppressCompletionDelivery === true,
  retireAfterRequesterTurn: current.retireAfterRequesterTurn === true,
  hasRequesterSettleWake: current.requesterSettleWake !== undefined,
  killIntent: current.killIntent && {
    requestedAt: current.killIntent.requestedAt,
    reason: current.killIntent.reason,
    lifecycleGeneration: current.killIntent.lifecycleGeneration,
    sessionId: current.killIntent.sessionId,
    sessionLifecycleRevision: current.killIntent.sessionLifecycleRevision,
    suppressTaskDelivery: current.killIntent.suppressTaskDelivery === true,
  },
  killReconciliation: current.killReconciliation && {
    killedAt: current.killReconciliation.killedAt,
    supersededAt: current.killReconciliation.supersededAt,
    taskCancellationAccepted: current.killReconciliation.taskCancellationAccepted === true,
    suppressTaskDelivery: current.killReconciliation.suppressTaskDelivery === true,
  },
  batchRunIds: current.requesterSettleWake?.batchRunIds?.toSorted(),
  rearmGeneration: current.requesterSettleWake?.rearmGeneration,
  requesterYieldBatch: current.requesterSettleWake?.requesterYieldBatch === true,
  yieldedFinalDeliverable: current.requesterSettleWake?.yieldedFinalDeliverable === true,
});

/** Async retirement cannot consume a newly rebound requester or cancellation obligation. */
export function isRequesterRetirementCustodyCurrent(
  current: SubagentRunRecord,
  expected: SubagentRunRecord,
): boolean {
  return isDeepStrictEqual(
    requesterRetirementCustody(current),
    requesterRetirementCustody(expected),
  );
}

/** Runtime cohort custody survives only its own immutable row publications. */
export function sameRequesterSettleBatch(
  left: readonly SubagentRunRecord[],
  right: readonly SubagentRunRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry) => right.some((candidate) => isSameSubagentRunOwner(candidate, entry)))
  );
}

export function resolveCurrentRequesterSettleBatch(
  observed: readonly SubagentRunRecord[],
  runs: ReadonlyMap<string, SubagentRunRecord>,
): SubagentRunRecord[] | undefined {
  const batch: SubagentRunRecord[] = [];
  for (const entry of observed) {
    const current = runs.get(entry.runId);
    if (!current || !isSameSubagentRunOwner(current, entry)) {
      return undefined;
    }
    batch.push(current);
  }
  return batch;
}

/** Rereads an observed batch; a member claimed by a live requester turn is not yet owed. */
export function resolveCurrentRequesterSettleWakeBatch(params: {
  observed: readonly SubagentRunRecord[];
  currentRuns: readonly SubagentRunRecord[];
  rearmGeneration: number | undefined;
  pause: boolean;
  isClaimedByLiveRequesterTurn: (entry: SubagentRunRecord) => boolean;
}): SubagentRunRecord[] | undefined {
  const batch: SubagentRunRecord[] = [];
  for (const observed of params.observed) {
    const entry = params.currentRuns.find((candidate) =>
      isSameSubagentRunOwner(candidate, observed),
    );
    const wake = entry?.requesterSettleWake;
    if (
      !entry ||
      params.isClaimedByLiveRequesterTurn(entry) ||
      !sameRequesterSettleRunIdentity(entry, observed) ||
      (wake?.yieldedFinalDeliverable === true) !==
        (observed.requesterSettleWake?.yieldedFinalDeliverable === true) ||
      !wake ||
      wake.rearmGeneration !== params.rearmGeneration ||
      (params.pause
        ? entry.pauseReason !== "sessions_yield" || !wake.pauseNotice
        : entry.pauseReason === "sessions_yield")
    ) {
      return undefined;
    }
    batch.push(entry);
  }
  return batch;
}

/** A yielded cohort owns exactly one rearm generation and its recorded membership. */
export function isRequesterYieldCohortMember(
  entry: SubagentRunRecord,
  batchRunIds: readonly string[],
  rearmGeneration: number | undefined,
): boolean {
  const wake = entry.requesterSettleWake;
  return (
    wake?.requesterYieldBatch === true &&
    wake.rearmGeneration === rearmGeneration &&
    wake.batchRunIds?.length === batchRunIds.length &&
    wake.batchRunIds.every((runId, index) => runId === batchRunIds[index])
  );
}
