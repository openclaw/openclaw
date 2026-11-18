import { getFollowupCohortOwner } from "../completion/session-followup-cohort.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { selectConnectedSettledSubagentWave } from "../registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  hasSameRequesterWakeCohort,
  hasSameRequesterWakePartition,
} from "../registry/subagent-requester-settle-identity.js";
import {
  hasSubagentRunEnded,
  isEndedSubagentMessageWait,
} from "../registry/subagent-run-liveness.js";
import { hasRetainedRequesterCronCohort } from "../requester-cron-authority.js";
import type { RequesterSettleWakeBatchState } from "./subagent-announce.requester-settle-state.js";

/** Select one invocation wave before dispatch can spend it. */
export function selectRequesterSettleWave(params: {
  requesterRuns: SubagentRunRecord[];
  currentSettledEntry: SubagentRunRecord;
  currentState: RequesterSettleWakeBatchState;
  pause: boolean;
}): { batch: SubagentRunRecord[]; partial: boolean; hasMessageWait: boolean } | undefined {
  const { requesterRuns, currentSettledEntry, currentState, pause } = params;
  const frozenBatchRunIds = currentState.batchRunIds;
  const hasCurrentWake = (entry: SubagentRunRecord | undefined): entry is SubagentRunRecord =>
    hasSameRequesterWakeCohort(entry, currentState);
  const hasSettled = (entry: SubagentRunRecord) =>
    entry.execution.status !== "running" &&
    entry.pauseReason !== "sessions_yield" &&
    hasSubagentRunEnded(entry);
  let settledBatch: SubagentRunRecord[];
  let partial = false;
  let hasMessageWait = false;
  if (pause) {
    settledBatch = [currentSettledEntry];
  } else if (frozenBatchRunIds?.length) {
    const runsById = new Map(requesterRuns.map((entry) => [entry.runId, entry]));
    // Retired rows no longer own completion, but every surviving frozen member
    // must be terminal before this batch can wake its requester.
    const frozenMembers = frozenBatchRunIds
      .map((runId) => runsById.get(runId))
      .filter(hasCurrentWake);
    if (currentState.partitionRunIds) {
      settledBatch = frozenMembers.filter((entry) =>
        hasSameRequesterWakePartition(entry, currentState),
      );
      partial = true;
      hasMessageWait = frozenMembers.some(isEndedSubagentMessageWait);
    } else {
      if (frozenMembers.some((entry) => entry.requesterSettleWake?.partitionRunIds)) {
        return undefined;
      }
      // An admitted input must still reconcile its original key. New offers may only
      // include results held by the same requester invocation as the anchor.
      settledBatch =
        currentState.attemptCount > 0
          ? frozenMembers
          : subagentRuns
              .selectCompletionAuthorityBatch(frozenMembers, currentSettledEntry)
              .filter((entry) => (entry.requesterSettleWake?.attemptCount ?? 0) === 0);
      const ready = settledBatch.filter(hasSettled);
      hasMessageWait =
        ready.length < settledBatch.length &&
        currentState.attemptCount === 0 &&
        settledBatch.every((entry) => hasSettled(entry) || isEndedSubagentMessageWait(entry)) &&
        !settledBatch.some(getFollowupCohortOwner) &&
        !hasRetainedRequesterCronCohort(settledBatch);
      if (hasMessageWait) {
        settledBatch = ready;
      }
      partial = settledBatch.length < frozenMembers.length;
    }
    if (!settledBatch.every(hasSettled)) {
      return undefined;
    }
  } else {
    // An unfrozen wave cannot absorb a different requester-yield generation.
    // Its frozen cohort still owns its deadline, retry budget, and visible final.
    settledBatch = selectConnectedSettledSubagentWave(
      subagentRuns.selectCompletionAuthorityBatch(
        requesterRuns.filter((entry) => hasCurrentWake(entry) && hasSettled(entry)),
        currentSettledEntry,
      ),
      currentSettledEntry,
    );
  }
  // Required completions stay with their requester turn; other rows keep its ID for cancellation.
  if (
    !settledBatch.some((entry) => entry.runId === currentSettledEntry.runId) ||
    settledBatch.some((run) => run.expectsCompletionMessage === true && run.requesterTurnRunId)
  ) {
    return undefined;
  }

  return { batch: settledBatch, partial, hasMessageWait };
}
