import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { AgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  resetRequesterSettleWakeRetry,
} from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { mutateSubagentRuns, SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner, latestSubagentRun } from "./subagent-run-generation.js";
import { isYieldedSubagentRun } from "./subagent-run-liveness.js";
import { resolveCompletionAfterHardRunDeadline } from "./subagent-run-timeout.js";

const COLLECTOR_YIELD_ERROR =
  "Collector yielded under a build that predates the admission gate, so it has no recorded collectorCompletion and nothing can continue it. Rerun the collector and have it end its turn normally instead of calling sessions_yield.";

type YieldedRunContinuation = { state: "continuable" } | { state: "unreachable"; error: string };

/**
 * Owns "can a continuation still resume this yielded run?" for a row where
 * `isYieldedSubagentRun` (run liveness) holds. Callers settle an unreachable run through the
 * completion owner instead of leaving it parked. Every other yielded row stays continuable.
 */
export function resolveYieldedRunContinuation(entry: SubagentRunRecord): YieldedRunContinuation {
  // A collector result is read by an explicit wait, never delivered by a continuation.
  return entry.collect === true && entry.collectorCompletion === undefined
    ? { state: "unreachable", error: COLLECTOR_YIELD_ERROR }
    : { state: "continuable" };
}

/** Whether the yield pause refuses this completion; a kill or an explicit settle may pass it. */
export function isCompletionHeldByYield(
  entry: SubagentRunRecord,
  request: Pick<SubagentCompletionRequest, "reason" | "settleYielded">,
): boolean {
  // A settle request outlives the sweep that issued it; it must not rewrite a run that has
  // since resumed, finished, or been claimed by a kill. A kill claim keeps its pause reason.
  return request.settleYielded === true
    ? !isYieldedSubagentRun(entry)
    : entry.pauseReason === "sessions_yield" && request.reason !== SUBAGENT_ENDED_REASON_KILLED;
}

/** Return the admitted observation so delayed lifecycle classification retains its attempt. */
export async function preserveSubagentRunForRestart(params: {
  entry: SubagentRunRecord;
  terminal: AgentRunTerminalOutcome;
  runs: Map<string, SubagentRunRecord>;
  context?: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
}): Promise<{ preserved: boolean; observedEntry: SubagentRunRecord }> {
  return mutateSubagentRuns(
    [params.entry.runId],
    (rows) => {
      const entry = rows.get(params.entry.runId);
      if (!entry || !isSameSubagentRunOwner(entry, params.entry)) {
        throw new Error("Subagent restart preservation lost its original run");
      }
      // A failed wait cannot replace a recorded interruption with an invented terminal.
      if (
        entry.execution.status === "interrupted" &&
        entry.execution.interruptionReason === "gateway-restart" &&
        params.terminal.endedAt === undefined &&
        (params.terminal.reason === "failed" || params.terminal.reason === "timed_out")
      ) {
        return { value: { preserved: true, observedEntry: entry } };
      }
      if (params.terminal.reason !== "cancelled" || params.terminal.stopReason !== "restart") {
        return { value: { preserved: false, observedEntry: entry } };
      }
      if (
        entry.execution.status === "terminal" ||
        typeof entry.execution.endedAt === "number" ||
        shouldSuppressSubagentRecoverySessionEffects(entry)
      ) {
        return { value: { preserved: true, observedEntry: entry } };
      }
      if (
        entry.killIntent ||
        entry.killReconciliation ||
        resolveCompletionAfterHardRunDeadline({
          entry,
          observedStartedAt: params.terminal.startedAt,
          observedEndedAt: params.terminal.endedAt,
          now: Date.now(),
        }) !== undefined
      ) {
        return { value: { preserved: false, observedEntry: entry } };
      }
      if (entry.execution.status === "interrupted") {
        return { value: { preserved: true, observedEntry: entry } };
      }
      return {
        value: { preserved: true, observedEntry: entry },
        postimages: new Map([
          [
            entry.runId,
            {
              ...entry,
              execution: {
                ...entry.execution,
                status: "interrupted" as const,
                interruptedAt: params.terminal.endedAt ?? Date.now(),
                interruptionReason: "gateway-restart" as const,
              },
            },
          ],
        ]),
      };
    },
    { runs: params.runs, context: params.context, assertCurrent: params.assertCurrent },
  );
}

type SubagentYieldClaim = "nothing-pending" | "pending-work" | { messageWaitRegistered: boolean };

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
  const endedAt = typeof params.endedAt === "number" ? params.endedAt : Date.now();
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
  for (const key of ["endedReason", "cleanupCompletedAt"] as const) {
    if (entry[key] !== undefined) {
      entry[key] = undefined;
      mutated = true;
    }
  }
  if (entry.cleanupHandled === true) {
    entry.cleanupHandled = false;
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
