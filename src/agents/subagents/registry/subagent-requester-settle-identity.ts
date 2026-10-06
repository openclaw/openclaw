import { isDeepStrictEqual } from "node:util";
import { buildAnnounceIdempotencyKey } from "../../announce-idempotency.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  isSameSubagentRun,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";

export function buildRequesterSettleWakeIdentity(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  batchRunIds: readonly string[];
  rearmGeneration?: number;
  attemptIndex?: number;
  /**
   * Private completion turns reuse one key across attempts: a retry must not republish
   * private input under a new identity. Deliverable turns suffix each retry so a
   * cached terminal failure cannot replay in place of a new delivery attempt.
   * Pause notices also use fresh attempts, even when their completion stays private.
   */
  sharedAttemptKey?: boolean;
  pause?: boolean;
}): { batchKey: string; runId: string } {
  const batchKey = [
    `requester-settle:${params.requesterAgentId ?? "unknown"}:${params.requesterSessionKey}:${params.batchRunIds.toSorted().join(",")}`,
    params.rearmGeneration === undefined ? undefined : `yield-${params.rearmGeneration}`,
    params.pause ? "pause" : undefined,
  ]
    .filter(Boolean)
    .join(":");
  const attemptIndex = params.attemptIndex ?? 0;
  return {
    batchKey,
    runId: buildAnnounceIdempotencyKey(
      (params.sharedAttemptKey && !params.pause) || attemptIndex === 0
        ? batchKey
        : `${batchKey}:retry-${attemptIndex}`,
    ),
  };
}

export function isRequesterSettleWakeForRun(params: {
  entry: SubagentRunRecord;
  runId: string;
  requesterSessionKey: string;
  requesterAgentId?: string;
  runsById: ReadonlyMap<string, SubagentRunRecord>;
}): boolean {
  const { entry, requesterSessionKey, requesterAgentId } = params;
  const wake = entry.requesterSettleWake;
  const pauseNotice = entry.pauseReason === "sessions_yield" && wake?.pauseNotice;
  const batchRunIds = pauseNotice ? [entry.runId] : wake?.batchRunIds;
  if (
    entry.requesterSessionKey !== requesterSessionKey ||
    (entry.requesterAgentId && entry.requesterAgentId !== requesterAgentId) ||
    !wake ||
    wake.attemptCount < 1 ||
    !isSameSubagentRun(params.runsById.get(entry.runId), entry) ||
    !batchRunIds?.includes(entry.runId)
  ) {
    return false;
  }
  // Mirrors the frozen admission policy: a yielded private batch that was
  // admitted as deliverable retries under fresh keys like any public batch.
  const sharedAttemptKey =
    wake.yieldedFinalDeliverable !== true &&
    batchRunIds.some((runId) => {
      const member = params.runsById.get(runId);
      return (
        member?.requesterSessionKey === requesterSessionKey &&
        (!member.requesterAgentId || member.requesterAgentId === requesterAgentId) &&
        member.requesterSettleWake !== undefined &&
        member.requesterSettleWake.rearmGeneration === wake.rearmGeneration &&
        member.completionTarget === "parent"
      );
    });
  // Pending backoff still belongs to the last admitted attempt, not its next retry.
  return (
    params.runId ===
    buildRequesterSettleWakeIdentity({
      requesterSessionKey,
      requesterAgentId,
      batchRunIds,
      rearmGeneration: wake.rearmGeneration,
      attemptIndex: wake.attemptCount - 1,
      sharedAttemptKey,
      pause: Boolean(pauseNotice),
    }).runId
  );
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

/** Wake decisions retain their observed progress; retirement/presentation metadata is carried forward. */
export function captureRequesterSettleWakeProgress(entry: SubagentRunRecord) {
  const wake = entry.requesterSettleWake;
  return (
    wake && {
      status: wake.status,
      attemptCount: wake.attemptCount,
      replayCount: wake.replayCount ?? 0,
      deferralCount: wake.deferralCount ?? 0,
      nextAttemptAt: wake.nextAttemptAt,
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

/** Retry preparation may refresh progress; retained delivery keeps its observed decision. */
export function resolveCurrentRequesterSettleWakeBatch(params: {
  observed: readonly SubagentRunRecord[];
  currentRuns: readonly SubagentRunRecord[];
  rearmGeneration: number | undefined;
  pause: boolean;
  requireUnchangedProgress: boolean;
}): SubagentRunRecord[] | undefined {
  const batch: SubagentRunRecord[] = [];
  for (const observed of params.observed) {
    const entry = params.currentRuns.find((candidate) =>
      isSameSubagentRunOwner(candidate, observed),
    );
    const wake = entry?.requesterSettleWake;
    if (
      !entry ||
      (entry.expectsCompletionMessage === true && entry.requesterTurnRunId) ||
      !isDeepStrictEqual(
        captureRequesterSettleRunIdentity(entry),
        captureRequesterSettleRunIdentity(observed),
      ) ||
      (wake?.yieldedFinalDeliverable === true) !==
        (observed.requesterSettleWake?.yieldedFinalDeliverable === true) ||
      !wake ||
      wake.rearmGeneration !== params.rearmGeneration ||
      (params.pause
        ? entry.pauseReason !== "sessions_yield" || !wake.pauseNotice
        : entry.pauseReason === "sessions_yield") ||
      (params.requireUnchangedProgress &&
        !isDeepStrictEqual(
          captureRequesterSettleWakeProgress(entry),
          captureRequesterSettleWakeProgress(observed),
        ))
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
