import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type SubagentTerminalState,
} from "./subagent-control.types.js";
import {
  SUBAGENT_ENDED_OUTCOME_ERROR,
  SUBAGENT_ENDED_OUTCOME_OK,
  SUBAGENT_ENDED_OUTCOME_TIMEOUT,
  SUBAGENT_ENDED_REASON_KILLED,
  SUBAGENT_TARGET_KIND_SUBAGENT,
  type SubagentLifecycleEndedOutcome,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { shouldDeferTerminalCleanupForUnconfirmedChild } from "./subagent-registry-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

const log = createSubsystemLogger("agents/subagent-registry-completion");

/**
 * Returns terminal execution facts only after completion capture has settled
 * and the child's stop has actually been observed.
 */
export function resolveFinalizedSubagentTaskState(
  entry: SubagentRunRecord,
): SubagentTerminalState | undefined {
  const endedAt = entry.execution.endedAt;
  const outcome = entry.execution.outcome;
  const completion = entry.completion;
  if (
    typeof endedAt !== "number" ||
    !outcome ||
    entry.pauseReason === "sessions_yield" ||
    (completion?.resultText === undefined && typeof completion?.capturedAt !== "number")
  ) {
    return undefined;
  }
  if (shouldDeferTerminalCleanupForUnconfirmedChild(entry)) {
    // A deadline-only expiry observed nothing about the child, so it must not
    // read as a terminal fact: a still-running child would otherwise be
    // reported stopped. Stay nonterminal; promotion resolves through this same
    // function with an observed outcome.
    return undefined;
  }
  const status =
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.suppressAnnounceReason !== "steer-restart"
      ? "cancelled"
      : outcome.status === "ok"
        ? "succeeded"
        : outcome.status === "timeout"
          ? "timed_out"
          : "failed";
  return {
    status,
    endedAt,
    error:
      status === "cancelled"
        ? SUBAGENT_KILL_TASK_ERROR
        : outcome.status === "error"
          ? outcome.error
          : undefined,
  };
}

/** Preserves execution end time, except when a paused run was killed after its yield. */
export function resolveKilledSubagentTaskEndedAt(entry: SubagentRunRecord): number | undefined {
  if (entry.killReconciliation) {
    return entry.killReconciliation.killedAt;
  }
  const endedAt = entry.execution.endedAt;
  const cleanupCompletedAt = entry.cleanupCompletedAt;
  return entry.suppressAnnounceReason === "killed" &&
    typeof endedAt === "number" &&
    typeof cleanupCompletedAt === "number" &&
    cleanupCompletedAt > endedAt
    ? cleanupCompletedAt
    : endedAt;
}

export function resolveLifecycleOutcomeFromRunOutcome(
  outcome: SubagentRunOutcome | undefined,
): SubagentLifecycleEndedOutcome {
  if (outcome?.status === "error") {
    return SUBAGENT_ENDED_OUTCOME_ERROR;
  }
  if (outcome?.status === "timeout") {
    return SUBAGENT_ENDED_OUTCOME_TIMEOUT;
  }
  return SUBAGENT_ENDED_OUTCOME_OK;
}

export async function emitSubagentProgressEndedHook(entry: SubagentRunRecord): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_progress")) {
    return;
  }
  const outcome =
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED
      ? "killed"
      : entry.execution.outcome
        ? resolveLifecycleOutcomeFromRunOutcome(entry.execution.outcome)
        : "unknown";
  try {
    await hookRunner.runSubagentProgress(
      {
        phase: "ended",
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        outcome,
        requester: entry.progressOrigin,
      },
      {
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
      },
    );
  } catch (err) {
    log.warn(
      `failed to emit subagent progress for run ${entry.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function emitSubagentEndedHookOnce(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  outcome?: SubagentLifecycleEndedOutcome;
  error?: string;
  inFlightOwners: Set<object>;
  recordEmitted: () => void | Promise<void>;
}) {
  const runId = params.entry.runId.trim();
  const owner = getSubagentRunRuntimeKey(params.entry);
  if (!runId || params.entry.endedHookEmittedAt || params.inFlightOwners.has(owner)) {
    return false;
  }

  // In-flight guard prevents concurrent completion paths from double-emitting
  // the hook before endedHookEmittedAt is persisted.
  params.inFlightOwners.add(owner);
  try {
    const hookRunner = getGlobalHookRunner();
    if (!hookRunner) {
      return false;
    }
    if (hookRunner.hasHooks("subagent_ended")) {
      await hookRunner.runSubagentEnded(
        {
          targetSessionKey: params.entry.childSessionKey,
          targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
          reason: params.reason,
          sendFarewell: params.sendFarewell,
          accountId: params.accountId,
          runId: params.entry.runId,
          endedAt: params.entry.execution.endedAt,
          outcome: params.outcome,
          error: params.error,
        },
        {
          runId: params.entry.runId,
          childSessionKey: params.entry.childSessionKey,
          requesterSessionKey: params.entry.requesterSessionKey,
        },
      );
    }
    await params.recordEmitted();
    return true;
  } catch (err) {
    if (hasSqliteWorkerOutcomeUnknown(err)) {
      throw err;
    }
    log.warn(
      `failed to emit subagent_ended hook for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    params.inFlightOwners.delete(owner);
  }
}
