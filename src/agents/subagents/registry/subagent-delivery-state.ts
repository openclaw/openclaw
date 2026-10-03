import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import type { RequesterSettleWakeBatchState } from "../announce/subagent-announce.requester-settle-state.js";
import type {
  PendingFinalDeliveryPayload,
  SubagentCompletionDeliveryState,
  SubagentRunReadRecord,
} from "./subagent-registry-read.types.js";
import type {
  RequesterSettleWakeState,
  SubagentCompletionState,
  SubagentRunMaintenanceRecord,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

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

/**
 * A pause uses the existing retry owner and keeps the member's own completion wake.
 * Its consumed notice hands the continuation to the requester, so the member leaves
 * its frozen wave: siblings stop waiting on it, and the resumed task reports alone.
 */
export function consumeSubagentPauseNotice(entry: SubagentRunRecord): boolean {
  const wake = entry.requesterSettleWake;
  if (entry.pauseReason !== "sessions_yield" || !wake?.pauseNotice) {
    return false;
  }
  const { pauseNotice: _notice, ...completionWake } = wake;
  entry.requesterSettleWake = {
    ...resetRequesterSettleWakeRetry(completionWake),
    batchRunIds: [entry.runId],
  };
  return true;
}

export function projectSubagentRunForSessionList(entry: SubagentRunRecord): SubagentRunReadRecord {
  return {
    runId: entry.runId,
    ...(entry.taskRunId !== undefined ? { taskRunId: entry.taskRunId } : {}),
    ...(entry.pauseReason ? { pauseReason: entry.pauseReason } : {}),
    ...(entry.swarmRunId ? { swarmRunId: entry.swarmRunId } : {}),
    childSessionKey: entry.childSessionKey,
    ...(entry.childAgentId ? { childAgentId: entry.childAgentId } : {}),
    ...(entry.controllerSessionKey ? { controllerSessionKey: entry.controllerSessionKey } : {}),
    requesterSessionKey: entry.requesterSessionKey,
    requesterStorePath: entry.requesterStorePath,
    controllerStorePath: entry.controllerStorePath,
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
      ...(entry.execution.interruptionReason
        ? { interruptionReason: entry.execution.interruptionReason }
        : {}),
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
            ...(entry.delivery.disposition === "intentional_non_delivery"
              ? { disposition: entry.delivery.disposition }
              : {}),
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
    ...(entry.childAgentId ? { childAgentId: entry.childAgentId } : {}),
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
  entry.taskRunId = normalizeOptionalString(entry.taskRunId);
  const requesterTurnRunId = normalizeOptionalString(entry.requesterTurnRunId);
  entry.requesterTurnRunId = requesterTurnRunId;
  entry.requesterTurnYielded =
    requesterTurnRunId && entry.requesterTurnYielded === true ? true : undefined;
  entry.retireAfterRequesterTurn =
    requesterTurnRunId && entry.retireAfterRequesterTurn === true ? true : undefined;
  entry.generation = asPositiveSafeInteger(entry.generation);
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
      lifecycleGeneration: normalizeOptionalString(killIntent.lifecycleGeneration),
      sessionId: normalizeOptionalString(killIntent.sessionId),
      sessionLifecycleRevision: normalizeOptionalString(killIntent.sessionLifecycleRevision),
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

export function ensureCompletionState(entry: SubagentRunRecord): SubagentCompletionState {
  entry.completion ??= {
    required: entry.expectsCompletionMessage === true,
  };
  return entry.completion;
}

export function ensureDeliveryState(entry: SubagentRunRecord): SubagentCompletionDeliveryState {
  entry.delivery ??= {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
  return entry.delivery;
}

export function clearDeliveryState(entry: SubagentRunRecord): void {
  entry.delivery = {
    status: entry.expectsCompletionMessage === false ? "not_required" : "pending",
  };
}

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

export function getDeliveryLastError(entry: SubagentRunRecord): string | undefined {
  const error = entry.delivery?.lastError;
  return typeof error === "string" && error.trim() ? error : undefined;
}

export const markRequesterSettleWakePending = (
  entry: SubagentRunRecord,
  options?: { retireAfterSettle?: boolean },
) => {
  const existing = entry.requesterSettleWake;
  entry.requesterSettleWake = {
    ...structuredClone(existing),
    status: existing?.status ?? "pending",
    attemptCount: existing?.attemptCount ?? 0,
    ...(existing?.retireAfterSettle === true || options?.retireAfterSettle === true
      ? { retireAfterSettle: true }
      : {}),
  } satisfies RequesterSettleWakeState;
};

export const clearSubagentPendingDelivery = (entry: SubagentRunRecord) => {
  const delivery = ensureDeliveryState(entry);
  delivery.payload = undefined;
  delivery.createdAt = undefined;
  delivery.lastAttemptAt = undefined;
  delivery.nextAttemptAt = undefined;
  delivery.attemptCount = undefined;
  delivery.lastError = undefined;
  delivery.suspendedAt = undefined;
  delivery.suspendedReason = undefined;
  if (delivery.status !== "delivered" && delivery.status !== "failed") {
    clearDeliveryState(entry);
  }
};

export const loadPendingFinalDeliveryPayload = (
  entry: SubagentRunRecord,
): PendingFinalDeliveryPayload => {
  return {
    requesterSessionKey: entry.delivery?.payload?.requesterSessionKey ?? entry.requesterSessionKey,
    requesterOrigin: entry.delivery?.payload?.requesterOrigin ?? entry.requesterOrigin,
    requesterDisplayKey: entry.delivery?.payload?.requesterDisplayKey ?? entry.requesterDisplayKey,
    childSessionKey: entry.delivery?.payload?.childSessionKey ?? entry.childSessionKey,
    childRunId: entry.delivery?.payload?.childRunId ?? entry.runId,
    task: entry.delivery?.payload?.task ?? entry.task,
    label: entry.delivery?.payload?.label ?? entry.label,
    startedAt: entry.delivery?.payload?.startedAt ?? entry.execution.startedAt,
    endedAt: entry.delivery?.payload?.endedAt ?? entry.execution.endedAt,
    outcome: entry.delivery?.payload?.outcome ?? entry.execution.outcome,
    expectsCompletionMessage:
      entry.delivery?.payload?.expectsCompletionMessage ?? entry.expectsCompletionMessage,
    completionTarget: entry.completionTarget,
    completionRequesterSessionId: entry.completionRequesterSessionId,
    spawnMode: entry.delivery?.payload?.spawnMode ?? entry.spawnMode,
    wakeOnDescendantSettle:
      entry.delivery?.payload?.wakeOnDescendantSettle ?? entry.wakeOnDescendantSettle,
    // Completion is the terminal-reply owner; a retry payload can predate its final receipt.
    terminalReply: entry.completion?.terminalReply ?? entry.delivery?.payload?.terminalReply,
  };
};

export function transitionRequesterSettleWakeState(
  entry: SubagentRunRecord,
  state: RequesterSettleWakeBatchState,
): void {
  entry.requesterSettleWake = {
    ...state,
    ...(entry.requesterSettleWake?.progressOperationId
      ? { progressOperationId: entry.requesterSettleWake.progressOperationId }
      : {}),
    ...(entry.requesterSettleWake?.retireAfterSettle === true ? { retireAfterSettle: true } : {}),
  };
}

export function completeRequesterSettleWakeState(entry: SubagentRunRecord): boolean {
  let retire = false;
  if (entry.pauseReason !== "sessions_yield") {
    if (entry.requesterTurnRunId && entry.expectsCompletionMessage === true) {
      entry.retireAfterRequesterTurn =
        entry.retireAfterRequesterTurn === true ||
        entry.requesterSettleWake?.retireAfterSettle === true
          ? true
          : undefined;
    } else {
      retire = entry.requesterSettleWake?.retireAfterSettle === true;
    }
  }
  entry.requesterSettleWake = undefined;
  return retire;
}
