import { buildAnnounceIdempotencyKey } from "../../announce-idempotency.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

export function buildRequesterSettleWakeIdentity(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  batchRunIds: readonly string[];
  rearmGeneration?: number;
  attemptIndex?: number;
  parentOnly?: boolean;
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
      (params.parentOnly && !params.pause) || attemptIndex === 0
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
    params.runsById.get(entry.runId) !== entry ||
    !batchRunIds?.includes(entry.runId)
  ) {
    return false;
  }
  const parentOnly = batchRunIds.some((runId) => {
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
      parentOnly,
      pause: Boolean(pauseNotice),
    }).runId
  );
}

/** Immutable run and requester bindings, distinct from mutable wake progress. */
export function captureRequesterSettleRunIdentity(entry: SubagentRunRecord) {
  return {
    runId: entry.runId,
    createdAt: entry.createdAt,
    generation: entry.generation,
    taskRunId: entry.taskRunId,
    childSessionKey: entry.childSessionKey,
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

/** Completion custody can outlive a requester that finished without explicitly yielding. */
export function hasRequesterCompletionCohort(entry: SubagentRunRecord): boolean {
  const wake = entry.requesterSettleWake;
  return (
    wake?.requesterYieldBatch === true ||
    (wake?.rearmGeneration !== undefined && wake.batchRunIds?.includes(entry.runId) === true)
  );
}

/** A frozen completion cohort can own distinct tasks that share one child session. */
export function isRequesterCompletionCohortCurrent(
  entry: SubagentRunRecord,
  cohort: readonly SubagentRunRecord[],
  latestForSession: (
    sessionKey: string,
    matches?: (candidate: SubagentRunRecord) => boolean,
  ) => SubagentRunRecord | null,
): boolean {
  const taskRunId = entry.taskRunId ?? entry.runId;
  const task = latestForSession(
    entry.childSessionKey,
    (candidate) => (candidate.taskRunId ?? candidate.runId) === taskRunId,
  );
  if (
    entry.killReconciliation?.supersededAt !== undefined ||
    (task && compareSubagentRunGeneration(task, entry) > 0)
  ) {
    return false;
  }
  const latest = latestForSession(entry.childSessionKey);
  return (
    !latest ||
    compareSubagentRunGeneration(latest, entry) <= 0 ||
    cohort.some(
      (candidate) =>
        candidate.runId === latest.runId &&
        candidate.generation === latest.generation &&
        candidate.requesterSessionKey === entry.requesterSessionKey &&
        candidate.requesterAgentId === entry.requesterAgentId &&
        candidate.requesterStorePath === entry.requesterStorePath &&
        candidate.requesterTurnRunId === entry.requesterTurnRunId &&
        (candidate.taskRunId ?? candidate.runId) !== taskRunId,
    )
  );
}
