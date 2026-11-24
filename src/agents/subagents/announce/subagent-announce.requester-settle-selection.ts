import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { selectConnectedSettledSubagentWave } from "../registry/subagent-registry-queries.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  hasSameRequesterWakeCohort,
  selectFrozenRequesterSettlePartition,
} from "../registry/subagent-requester-settle-identity.js";
import { isRequesterSettleMemberReady } from "../registry/subagent-run-liveness.js";
import type { RequesterSettleWakeBatchState } from "./subagent-announce.requester-settle-state.js";

/** Select one invocation wave before dispatch can spend it. */
export function selectRequesterSettleWave(params: {
  requesterRuns: SubagentRunRecord[];
  currentSettledEntry: SubagentRunRecord;
  currentState: RequesterSettleWakeBatchState;
  pause: boolean;
}): { batch: SubagentRunRecord[]; partial: boolean } | undefined {
  const { requesterRuns, currentSettledEntry, currentState, pause } = params;
  const frozenBatchRunIds = currentState.batchRunIds;
  const hasCurrentWake = (entry: SubagentRunRecord | undefined): entry is SubagentRunRecord =>
    hasSameRequesterWakeCohort(entry, currentState);
  let settledBatch: SubagentRunRecord[];
  let partial = false;
  if (pause) {
    settledBatch = [currentSettledEntry];
  } else if (frozenBatchRunIds?.length) {
    const runsById = new Map(requesterRuns.map((entry) => [entry.runId, entry]));
    const partition = selectFrozenRequesterSettlePartition(
      currentSettledEntry,
      (runId) => runsById.get(runId),
      (entries, anchor) => subagentRuns.selectCompletionAuthorityBatch(entries, anchor),
    );
    settledBatch = partition?.ready ?? [];
    partial = currentState.partitionRunIds !== undefined || Boolean(partition?.pending.length);
  } else {
    // An unfrozen wave cannot absorb a different requester-yield generation.
    // Its frozen cohort still owns its deadline, retry budget, and visible final.
    settledBatch = selectConnectedSettledSubagentWave(
      subagentRuns.selectCompletionAuthorityBatch(
        requesterRuns.filter(
          (entry) => hasCurrentWake(entry) && isRequesterSettleMemberReady(entry),
        ),
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

  return { batch: settledBatch, partial };
}
