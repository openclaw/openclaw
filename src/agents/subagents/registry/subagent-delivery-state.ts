import { normalizeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import type {
  SubagentCompletionDeliveryState,
  SubagentRunReadRecord,
} from "./subagent-registry-read.types.js";
import type {
  SubagentCompletionState,
  SubagentRunMaintenanceRecord,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export function projectSubagentRunForSessionList(entry: SubagentRunRecord): SubagentRunReadRecord {
  return {
    runId: entry.runId,
    ...(entry.pauseReason ? { pauseReason: entry.pauseReason } : {}),
    ...(entry.swarmRunId ? { swarmRunId: entry.swarmRunId } : {}),
    childSessionKey: entry.childSessionKey,
    ...(entry.controllerSessionKey ? { controllerSessionKey: entry.controllerSessionKey } : {}),
    requesterSessionKey: entry.requesterSessionKey,
    ...(entry.collect
      ? {
          collect: true,
          groupId: entry.groupId,
          swarmRequesterSessionKey: entry.swarmRequesterSessionKey,
        }
      : {}),
    ...(entry.collectorCompletion
      ? { collectorCompletion: { status: entry.collectorCompletion.status } }
      : {}),
    ...(entry.requesterAgentId ? { requesterAgentId: entry.requesterAgentId } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
    createdAt: entry.createdAt,
    execution: {
      status: entry.execution.status,
      ...(entry.execution.startedAt !== undefined ? { startedAt: entry.execution.startedAt } : {}),
      ...(entry.execution.endedAt !== undefined ? { endedAt: entry.execution.endedAt } : {}),
      ...(entry.execution.outcome ? { outcome: { status: entry.execution.outcome.status } } : {}),
    },
    ...(entry.sessionStartedAt !== undefined ? { sessionStartedAt: entry.sessionStartedAt } : {}),
    ...(entry.accumulatedRuntimeMs !== undefined
      ? { accumulatedRuntimeMs: entry.accumulatedRuntimeMs }
      : {}),
    ...(entry.runTimeoutSeconds !== undefined
      ? { runTimeoutSeconds: entry.runTimeoutSeconds }
      : {}),
    ...(entry.endedReason ? { endedReason: entry.endedReason } : {}),
    ...(entry.cleanupCompletedAt !== undefined
      ? { cleanupCompletedAt: entry.cleanupCompletedAt }
      : {}),
    ...(entry.delivery
      ? {
          delivery: {
            status: entry.delivery.status,
            ...(entry.delivery.suspendedAt !== undefined
              ? { suspendedAt: entry.delivery.suspendedAt }
              : {}),
          },
        }
      : {}),
  };
}

/** Copy only protection facts; live memory retains its existing, unnormalized semantics. */
export function projectSubagentRunForMaintenance(
  entry: SubagentRunRecord,
): SubagentRunMaintenanceRecord {
  return {
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    createdAt: entry.createdAt,
    cleanupCompletedAt: entry.cleanupCompletedAt,
    expectsCompletionMessage: entry.expectsCompletionMessage,
    killIntent: entry.killIntent ? { ...entry.killIntent } : entry.killIntent,
    killReconciliation: entry.killReconciliation
      ? { ...entry.killReconciliation }
      : entry.killReconciliation,
    execution: { status: entry.execution.status, endedAt: entry.execution.endedAt },
    delivery: entry.delivery
      ? { status: entry.delivery.status, suspendedAt: entry.delivery.suspendedAt }
      : undefined,
  };
}

export function normalizeSubagentRunState(entry: SubagentRunRecord): SubagentRunRecord {
  const taskRunId = typeof entry.taskRunId === "string" ? entry.taskRunId.trim() : "";
  entry.taskRunId = taskRunId || undefined;
  const requesterTurnRunId =
    typeof entry.requesterTurnRunId === "string" ? entry.requesterTurnRunId.trim() : "";
  entry.requesterTurnRunId = requesterTurnRunId || undefined;
  entry.requesterTurnYielded =
    requesterTurnRunId && entry.requesterTurnYielded === true ? true : undefined;
  entry.retireAfterRequesterTurn =
    requesterTurnRunId && entry.retireAfterRequesterTurn === true ? true : undefined;
  entry.generation =
    typeof entry.generation === "number" &&
    Number.isSafeInteger(entry.generation) &&
    entry.generation > 0
      ? entry.generation
      : undefined;
  entry.deleteCleanupDispatchedAt = Number.isFinite(entry.deleteCleanupDispatchedAt)
    ? entry.deleteCleanupDispatchedAt
    : undefined;
  entry.suppressCompletionDelivery = entry.suppressCompletionDelivery === true ? true : undefined;
  entry.terminalOwner =
    entry.terminalOwner === "interrupted-recovery" &&
    Number.isFinite(entry.execution.endedAt) &&
    entry.execution.outcome?.status === "error" &&
    entry.endedReason === "subagent-error" &&
    entry.pauseReason !== "sessions_yield"
      ? "interrupted-recovery"
      : undefined;
  if (entry.completion) {
    entry.completion.terminalReply = normalizeAgentRunTerminalReplySnapshot(
      entry.completion.terminalReply,
    );
  }
  const killReconciliation = entry.killReconciliation;
  if (
    !killReconciliation ||
    typeof killReconciliation !== "object" ||
    !Number.isFinite(killReconciliation.killedAt)
  ) {
    delete entry.killReconciliation;
  } else {
    entry.killReconciliation = {
      killedAt: killReconciliation.killedAt,
      taskCancellationAccepted:
        killReconciliation.taskCancellationAccepted === true ? true : undefined,
      suppressTaskDelivery: killReconciliation.suppressTaskDelivery === true ? true : undefined,
      supersededAt: Number.isFinite(killReconciliation.supersededAt)
        ? killReconciliation.supersededAt
        : undefined,
    };
  }
  const killIntent = entry.killIntent;
  if (
    !killIntent ||
    typeof killIntent !== "object" ||
    !Number.isFinite(killIntent.requestedAt) ||
    typeof killIntent.reason !== "string" ||
    !killIntent.reason.trim()
  ) {
    delete entry.killIntent;
  } else {
    entry.killIntent = {
      requestedAt: killIntent.requestedAt,
      reason: killIntent.reason.trim(),
      lifecycleGeneration:
        typeof killIntent.lifecycleGeneration === "string" && killIntent.lifecycleGeneration.trim()
          ? killIntent.lifecycleGeneration.trim()
          : undefined,
      sessionId:
        typeof killIntent.sessionId === "string" && killIntent.sessionId.trim()
          ? killIntent.sessionId.trim()
          : undefined,
      sessionLifecycleRevision:
        typeof killIntent.sessionLifecycleRevision === "string" &&
        killIntent.sessionLifecycleRevision.trim()
          ? killIntent.sessionLifecycleRevision.trim()
          : undefined,
      suppressTaskDelivery: killIntent.suppressTaskDelivery === true ? true : undefined,
    };
  }
  // cleanupHandled is an in-process lock; after restart, unfinished cleanup must
  // retry unless durable cleanup completion was recorded.
  if (
    entry.cleanupHandled === true &&
    typeof entry.cleanupCompletedAt !== "number" &&
    entry.delivery?.status !== "discarded"
  ) {
    entry.cleanupHandled = false;
  }
  return entry;
}

/** Ensures a run has a nested completion state object. */
export function ensureCompletionState(entry: SubagentRunRecord): SubagentCompletionState {
  entry.completion ??= {
    required: entry.expectsCompletionMessage === true,
  };
  return entry.completion;
}

/** Ensures a run has a nested delivery state object. */
export function ensureDeliveryState(entry: SubagentRunRecord): SubagentCompletionDeliveryState {
  entry.delivery ??= {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
  return entry.delivery;
}

/** Resets delivery state to its initial status for the run's completion requirement. */
export function clearDeliveryState(entry: SubagentRunRecord): void {
  entry.delivery = {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
}

/** Returns true when delivery is suspended with a durable timestamp. */
export function isDeliverySuspended(entry: Pick<SubagentRunRecord, "delivery">): boolean {
  return entry.delivery?.status === "suspended" && typeof entry.delivery.suspendedAt === "number";
}

/** A finished requester without its required message receipt must not execute again implicitly. */
export function isCompletedRequesterDeliveryBlocked(
  entry: Pick<SubagentRunRecord, "delivery">,
): boolean {
  return (
    isDeliverySuspended(entry) &&
    entry.delivery?.suspendedReason === "permanent_failure" &&
    entry.delivery.lastDropReason === "message_tool_delivery_missing"
  );
}

/** Returns true when required delivery still owns the row after its child session is gone. */
export function hasRetainedRequiredCompletionDelivery(
  entry: Pick<
    SubagentRunRecord,
    "completion" | "delivery" | "expectsCompletionMessage" | "suppressCompletionDelivery"
  >,
): boolean {
  const delivery = entry.delivery;
  if (
    entry.expectsCompletionMessage !== true ||
    entry.suppressCompletionDelivery === true ||
    entry.completion?.required !== true ||
    !delivery?.payload
  ) {
    return false;
  }
  if (isDeliverySuspended(entry)) {
    return true;
  }
  if (delivery.status === "in_progress") {
    // The correlated session queue owns this delivery and resumes it separately.
    return true;
  }
  return (
    delivery.status === "pending" &&
    delivery.disposition !== "ambiguous" &&
    delivery.disposition !== "intentional_non_delivery" &&
    delivery.disposition !== "permanent_failure"
  );
}

/** Reads the current delivery attempt count. */
export function getDeliveryAttemptCount(entry: SubagentRunRecord): number {
  return entry.delivery?.attemptCount ?? 0;
}

/** Reads the non-empty last delivery error. */
export function getDeliveryLastError(entry: SubagentRunRecord): string | undefined {
  const error = entry.delivery?.lastError;
  return typeof error === "string" && error.trim() ? error : undefined;
}
