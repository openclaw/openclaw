import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
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
    privateInput: undefined,
    nextAttemptAt: undefined,
    lastError: undefined,
  };
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

export function projectSubagentRunForSessionList(entry: SubagentRunRecord): SubagentRunReadRecord {
  return {
    runId: entry.runId,
    taskRunId: entry.taskRunId,
    pauseReason: entry.pauseReason || undefined,
    swarmRunId: entry.swarmRunId || undefined,
    schedulerSlotId: entry.schedulerSlotId || undefined,
    swarmLaunchReplayKey: entry.swarmLaunchReplayKey || undefined,
    childSessionKey: entry.childSessionKey,
    childAgentId: entry.childAgentId || undefined,
    controllerSessionKey: entry.controllerSessionKey || undefined,
    requesterSessionKey: entry.requesterSessionKey,
    requesterStorePath: entry.requesterStorePath,
    controllerStorePath: entry.controllerStorePath,
    collect: entry.collect || undefined,
    groupId: entry.collect ? entry.groupId : undefined,
    swarmRequesterSessionKey: entry.collect ? entry.swarmRequesterSessionKey : undefined,
    collectorCompletion: entry.collectorCompletion && { status: entry.collectorCompletion.status },
    requesterAgentId: entry.requesterAgentId || undefined,
    model: entry.model || undefined,
    generation: entry.generation,
    createdAt: entry.createdAt,
    execution: {
      status: entry.execution.status,
      startedAt: entry.execution.startedAt,
      endedAt: entry.execution.endedAt,
      outcome: entry.execution.outcome && { status: entry.execution.outcome.status },
    },
    sessionStartedAt: entry.sessionStartedAt,
    accumulatedRuntimeMs: entry.accumulatedRuntimeMs,
    runTimeoutSeconds: entry.runTimeoutSeconds,
    endedReason: entry.endedReason || undefined,
    cleanupCompletedAt: entry.cleanupCompletedAt,
    delivery: entry.delivery && {
      status: entry.delivery.status,
      requesterDelivery: entry.delivery.requesterDelivery,
      disposition: entry.delivery.disposition || undefined,
      suspendedAt: entry.delivery.suspendedAt,
    },
  };
}

export function shouldPreserveSubagentForMaintenance(entry: SubagentRunMaintenanceRecord): boolean {
  if (entry.killReconciliation || entry.killIntent || entry.requesterSettleWake) {
    // Requester settlement still reads child policy after child cleanup has completed.
    // Reconciliation tombstones own provider results until completion or cancellation settles.
    return true;
  }
  if (typeof entry.cleanupCompletedAt === "number") {
    return false;
  }
  return (
    typeof entry.execution.endedAt !== "number" ||
    (entry.expectsCompletionMessage === true && entry.delivery?.status !== "delivered") ||
    entry.delivery?.status === "pending" ||
    isDeliverySuspended(entry)
  );
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
    requesterSettleWake: entry.requesterSettleWake
      ? { status: entry.requesterSettleWake.status }
      : undefined,
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
  // Only the durable session queue can retain in-progress delivery across restart.
  if (entry.delivery?.status === "in_progress" && !entry.delivery.queueId) {
    entry.delivery = { ...entry.delivery, status: "pending" };
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

export function recordRequesterDelivery(
  entry: SubagentRunRecord,
  fact: NonNullable<SubagentCompletionDeliveryState["requesterDelivery"]>,
): void {
  const delivery = ensureDeliveryState(entry);
  if (delivery.requesterDelivery?.state !== "consumed") {
    delivery.requesterDelivery = fact;
  }
  if (delivery.status === "pending" || delivery.status === "in_progress") {
    delivery.disposition = undefined;
    delivery.lastError = undefined;
  }
}

/** A result committed to the requester transcript is never replayed. */
export function hasConsumedRequesterInput(entry: SubagentRunRecord): boolean {
  return entry.delivery?.requesterDelivery?.state === "consumed";
}

/** A private result is delivered by its committed input; a yielded final also owes an answer. */
export function hasConsumedPrivateRequesterInput(entry: SubagentRunRecord): boolean {
  return (
    hasConsumedRequesterInput(entry) &&
    entry.requesterSettleWake?.yieldedFinalDeliverable !== true &&
    (entry.completionTarget === "parent" || entry.requesterSettleWake?.privateInput !== undefined)
  );
}

// The requester turn itself stopped; no answer exists to deliver.
const REQUESTER_TURN_FAILURES = new Set<SubagentAnnounceDeliveryResult["reason"]>([
  "requester_aborted",
  "requester_timed_out",
  "requester_preparation_changed",
  "requester_state_conflict",
  "requester_transcript_conflict",
]);

/**
 * A committed result is delivered when its turn failed before answering. A turn that answered,
 * or ended for a recorded reason, keeps its own outcome: a missed send stays a failure.
 */
export function resolveRequesterDeliveryOutcome(
  entries: readonly SubagentRunRecord[],
  outcome: SubagentAnnounceDeliveryResult | undefined,
): SubagentAnnounceDeliveryResult | undefined {
  const turnFailedBeforeAnswer =
    outcome?.finalAssistantVisibleText === undefined &&
    (outcome?.reason === undefined || REQUESTER_TURN_FAILURES.has(outcome.reason));
  return outcome &&
    !outcome.delivered &&
    entries.length > 0 &&
    entries.every(
      (entry) =>
        hasConsumedPrivateRequesterInput(entry) ||
        (turnFailedBeforeAnswer && hasConsumedRequesterInput(entry)),
    )
    ? { delivered: true, path: "direct" }
    : outcome;
}

export function recordRequesterHandoff(entry: SubagentRunRecord, blockingRunId?: string): void {
  recordRequesterDelivery(entry, {
    ...entry.delivery?.requesterDelivery,
    state: "waiting",
    blockingRunId: blockingRunId ?? entry.delivery?.requesterDelivery?.blockingRunId,
  });
}

export function isDeliverySuspended(entry: Pick<SubagentRunRecord, "delivery">): boolean {
  return entry.delivery?.status === "suspended" && typeof entry.delivery.suspendedAt === "number";
}

/** A finished requester without its required reply receipt must not execute again implicitly. */
export function isCompletedRequesterDeliveryBlocked(
  entry: Pick<SubagentRunRecord, "delivery">,
): boolean {
  return (
    isDeliverySuspended(entry) &&
    entry.delivery?.suspendedReason === "permanent_failure" &&
    (entry.delivery.lastDropReason === "message_tool_delivery_missing" ||
      entry.delivery.lastDropReason === "visible_reply_missing")
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
    ...existing,
    status: existing?.status ?? "pending",
    attemptCount: existing?.attemptCount ?? 0,
    ...(existing?.retireAfterSettle === true || options?.retireAfterSettle === true
      ? { retireAfterSettle: true }
      : {}),
  } satisfies RequesterSettleWakeState;
};

export const clearSubagentPendingDelivery = (entry: SubagentRunRecord) => {
  const delivery = ensureDeliveryState(entry);
  if (delivery.requesterDelivery?.state === "waiting") {
    delivery.requesterDelivery = undefined;
  }
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
  state: Omit<RequesterSettleWakeState, "retireAfterSettle">,
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
