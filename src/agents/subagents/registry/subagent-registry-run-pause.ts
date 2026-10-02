import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  resetRequesterSettleWakeRetry,
} from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { mutateSubagentRuns, SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Capture the accepted tool intent before the runtime publishes its yielded terminal. */
export async function markSubagentMessageWaitInRuns(params: {
  runId: string;
  sessionKey: string;
  acknowledgment?: string;
  runs: Map<string, SubagentRunRecord>;
  context: OpenClawStateWorkerContext;
  assertCurrent: () => void;
}): Promise<boolean> {
  const registered = await mutateSubagentRuns(
    [params.runId],
    (rows) => {
      const entry = rows.get(params.runId);
      if (
        !entry ||
        entry.childSessionKey !== params.sessionKey ||
        entry.expectsCompletionMessage !== true ||
        entry.collect ||
        entry.execution.status !== "running" ||
        entry.killIntent ||
        entry.killReconciliation ||
        entry.suppressCompletionDelivery
      ) {
        return { value: false };
      }
      if (entry.requesterSettleWake?.pauseNotice) {
        return { value: true };
      }
      const next = structuredClone(entry);
      next.requesterSettleWake = {
        ...resetRequesterSettleWakeRetry(entry.requesterSettleWake),
        batchRunIds: entry.requesterSettleWake?.batchRunIds ?? [entry.runId],
        pauseNotice: {
          acknowledgment: truncateUtf16Safe(
            params.acknowledgment?.trim() || "Paused awaiting continuation.",
            12_000,
          ),
        },
      };
      return { value: true, postimages: new Map([[entry.runId, next]]) };
    },
    { runs: params.runs, context: params.context, assertCurrent: params.assertCurrent },
  );
  try {
    params.assertCurrent();
  } catch (error) {
    throw new SubagentRegistryWriteError(
      registered ? "committed" : "not-committed",
      error,
      registered ? "published" : undefined,
    );
  }
  return registered;
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
