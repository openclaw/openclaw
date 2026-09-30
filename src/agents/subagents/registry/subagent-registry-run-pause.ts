import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { clearDeliveryState, ensureCompletionState } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import {
  captureSubagentRunMutationSnapshot,
  publishSubagentRunPostimages,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import type { RequesterSettleWakeState, SubagentRunRecord } from "./subagent-registry.types.js";
import { latestSubagentRun } from "./subagent-run-generation.js";

export function resetRequesterSettleWakeRetry(
  wake?: RequesterSettleWakeState,
): RequesterSettleWakeState {
  return {
    ...wake,
    status: "pending",
    attemptCount: 0,
    replayCount: undefined,
    nextAttemptAt: undefined,
    deferralCount: undefined,
    lastError: undefined,
  };
}

/** Capture the accepted tool intent before the runtime publishes its yielded terminal. */
export async function claimSubagentYieldInRuns(params: {
  runId: string;
  sessionKey: string;
  acknowledgment?: string;
  waitForMessage: boolean;
  hasPendingWork: () => boolean;
  runs: Map<string, SubagentRunRecord>;
  context: OpenClawStateWorkerContext;
  assertCurrent: () => void;
  persist: Parameters<typeof publishSubagentRunPostimages>[0]["persist"];
}): Promise<"accepted" | "nothing-pending" | "pending-work"> {
  params.assertCurrent();
  const entry = params.runs.get(params.runId);
  if (
    !entry ||
    entry.childSessionKey !== params.sessionKey ||
    entry.collect ||
    entry.execution.status !== "running" ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.suppressCompletionDelivery
  ) {
    return "nothing-pending";
  }
  const taskRunId = entry.taskRunId ?? entry.runId;
  const ownsTaskGeneration = () =>
    params.runs.get(params.runId) === entry &&
    latestSubagentRun(
      params.runs.values(),
      (candidate) =>
        candidate.childSessionKey === params.sessionKey &&
        (candidate.taskRunId ?? candidate.runId) === taskRunId,
    ) === entry;
  // A separate followup may share this session without replacing this task.
  if (!ownsTaskGeneration()) {
    return "nothing-pending";
  }
  if (params.hasPendingWork()) {
    return "pending-work";
  }
  if (!params.waitForMessage) {
    return "nothing-pending";
  }
  // Quiet tasks can pause too, but never acquire an announcing obligation.
  if (entry.expectsCompletionMessage !== true || entry.requesterSettleWake?.pauseNotice) {
    return "accepted";
  }
  const assertCurrent = () => {
    params.assertCurrent();
    if (!ownsTaskGeneration()) {
      throw new Error("Subagent message wait lost its current task generation");
    }
    if (params.hasPendingWork()) {
      throw new Error("Subagent message wait acquired pending background work");
    }
  };
  const previous = captureSubagentRunMutationSnapshot(entry);
  entry.requesterSettleWake = {
    ...resetRequesterSettleWakeRetry(previous.requesterSettleWake),
    batchRunIds: previous.requesterSettleWake?.batchRunIds ?? [entry.runId],
    pauseNotice: {
      // Match the announce completion delivery's retained-text bound.
      acknowledgment: truncateUtf16Safe(
        params.acknowledgment?.trim() || "Paused awaiting continuation.",
        12_000,
      ),
    },
  };
  const result = await publishSubagentRunPostimages({
    runs: params.runs,
    previous: new Map([[entry, previous]]),
    persist: params.persist,
    context: params.context,
    assertCurrent,
  });
  try {
    assertCurrent();
    if (result.publication !== "published") {
      throw new Error("Subagent message wait lost its original run");
    }
  } catch (error) {
    throw new SubagentRegistryWriteError("committed", error, result.publication);
  }
  return "accepted";
}

/** A pause uses the existing retry owner, but never consumes the completion cohort. */
export function consumeSubagentPauseNotice(entry: SubagentRunRecord): boolean {
  const wake = entry.requesterSettleWake;
  if (entry.pauseReason !== "sessions_yield" || !wake?.pauseNotice) {
    return false;
  }
  const { pauseNotice: _notice, ...completionWake } = wake;
  entry.requesterSettleWake = resetRequesterSettleWakeRetry(completionWake);
  return true;
}

export function markSubagentRunPausedAfterYield(params: {
  entry: SubagentRunRecord;
  startedAt?: number;
  endedAt?: number;
  now?: number;
}): boolean {
  const { entry } = params;
  if (
    entry.terminalOwner === "interrupted-recovery" ||
    shouldSuppressSubagentRecoverySessionEffects(entry) ||
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED ||
    entry.suppressAnnounceReason === "killed" ||
    (entry.cleanup === "delete" && Number.isFinite(entry.deleteCleanupDispatchedAt))
  ) {
    // agent.wait and lifecycle events can report an old yield after terminal
    // ownership settles. Reviving the row would expose a run whose session may
    // belong to a newer lifecycle or already be gone.
    return false;
  }
  let mutated = false;
  if (typeof params.startedAt === "number" && entry.execution.startedAt !== params.startedAt) {
    entry.execution = { ...entry.execution, startedAt: params.startedAt };
    if (typeof entry.sessionStartedAt !== "number") {
      entry.sessionStartedAt = params.startedAt;
    }
    mutated = true;
  }
  const endedAt = typeof params.endedAt === "number" ? params.endedAt : (params.now ?? Date.now());
  if (
    entry.execution.status !== "terminal" ||
    entry.execution.endedAt !== endedAt ||
    entry.execution.outcome !== undefined
  ) {
    entry.execution = { ...entry.execution, status: "terminal", endedAt };
    delete entry.execution.outcome;
    mutated = true;
  }
  if (entry.pauseReason !== "sessions_yield") {
    entry.pauseReason = "sessions_yield";
    mutated = true;
  }
  if (entry.archiveAtMs !== undefined) {
    delete entry.archiveAtMs;
    mutated = true;
  }
  if (entry.endedReason !== undefined) {
    entry.endedReason = undefined;
    mutated = true;
  }
  if (entry.cleanupHandled === true) {
    entry.cleanupHandled = false;
    mutated = true;
  }
  if (entry.cleanupCompletedAt !== undefined) {
    entry.cleanupCompletedAt = undefined;
    mutated = true;
  }
  if (entry.delivery !== undefined) {
    clearDeliveryState(entry);
    mutated = true;
  }
  const completion = ensureCompletionState(entry);
  if (completion.resultText !== undefined) {
    completion.resultText = undefined;
    completion.capturedAt = undefined;
    completion.terminalReply = undefined;
    mutated = true;
  }
  return mutated;
}
