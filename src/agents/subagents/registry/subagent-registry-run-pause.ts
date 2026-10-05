import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  resetRequesterSettleWakeRetry,
} from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { mutateSubagentRuns, SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner, latestSubagentRun } from "./subagent-run-generation.js";

const COLLECTOR_YIELD_ERROR =
  "Collector yielded without recording a result, and no continuation can resume a collector. Run it again and end its turn normally.";

type YieldedRunContinuation = { state: "continuable" } | { state: "unreachable"; error: string };

/**
 * Owns "can a continuation still resume this yielded run?" for a row where
 * `isYieldedSubagentRun` (execution observation) holds. Callers settle an unreachable run through the
 * completion owner instead of leaving it parked. Every other yielded row stays continuable.
 */
export function resolveYieldedRunContinuation(entry: SubagentRunRecord): YieldedRunContinuation {
  // A collector result is read by an explicit wait, never delivered by a continuation.
  return entry.collect === true && entry.collectorCompletion === undefined
    ? { state: "unreachable", error: COLLECTOR_YIELD_ERROR }
    : { state: "continuable" };
}

export type SubagentYieldClaim =
  | "nothing-pending"
  | "pending-work"
  | { messageWaitRegistered: boolean };

/** Claim a live native task, recording announcing waits before the yielded terminal. */
export async function claimSubagentYieldInRuns(params: {
  runId: string;
  sessionKey: string;
  agentId: string;
  waitForMessage: boolean;
  acknowledgment?: string;
  hasPendingWork: () => boolean;
  runs: Map<string, SubagentRunRecord>;
  context: OpenClawStateWorkerContext;
  assertCurrent: () => void;
}): Promise<SubagentYieldClaim> {
  const expected = params.runs.get(params.runId);
  const isEligible = (entry: SubagentRunRecord | undefined): entry is SubagentRunRecord =>
    Boolean(
      entry &&
      isSameSubagentRunOwner(entry, expected) &&
      matchesSubagentChildSessionOwner(entry, params.sessionKey, params.agentId) &&
      !entry.collect &&
      entry.execution.status === "running" &&
      !entry.killIntent &&
      !entry.killReconciliation &&
      !entry.suppressCompletionDelivery &&
      // A separate admitted follow-up shares the session, not this logical task.
      isSameSubagentRunOwner(
        entry,
        latestSubagentRun(
          params.runs.values(),
          (candidate) =>
            matchesSubagentChildSessionOwner(candidate, params.sessionKey, params.agentId) &&
            (candidate.taskRunId ?? candidate.runId) === (entry.taskRunId ?? entry.runId),
        ),
      ),
    );
  params.assertCurrent();
  if (!isEligible(expected)) {
    return "nothing-pending";
  }
  if (params.hasPendingWork()) {
    return "pending-work";
  }
  if (!params.waitForMessage) {
    return "nothing-pending";
  }
  const assertCurrent = () => {
    params.assertCurrent();
    if (!isEligible(params.runs.get(params.runId))) {
      throw new Error("Subagent yield lost its current native task");
    }
    if (params.hasPendingWork()) {
      throw new Error("Subagent yield has uncollected background work");
    }
  };
  let published = false;
  const claim = await mutateSubagentRuns(
    [params.runId],
    (rows) => {
      const entry = rows.get(params.runId);
      if (!entry) {
        throw new Error("Subagent yield lost its current native task");
      }
      // Quiet native tasks may pause, but do not acquire a requester notice.
      if (entry.expectsCompletionMessage !== true) {
        return { value: { messageWaitRegistered: false } };
      }
      if (entry.requesterSettleWake?.pauseNotice) {
        return { value: { messageWaitRegistered: true } };
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
      return { value: { messageWaitRegistered: true }, postimages: new Map([[entry.runId, next]]) };
    },
    {
      runs: params.runs,
      context: params.context,
      assertCurrent,
      onPublished: () => {
        published = true;
      },
    },
  );
  try {
    // Publication retains the runtime owner across immutable metadata copies.
    assertCurrent();
  } catch (error) {
    throw new SubagentRegistryWriteError(
      published ? "committed" : "not-committed",
      error,
      published ? "published" : undefined,
    );
  }
  return claim;
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
