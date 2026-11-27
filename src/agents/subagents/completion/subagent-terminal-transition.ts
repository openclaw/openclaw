import { isDeepStrictEqual } from "node:util";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { mergeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import { resolveSubagentChildAuthority } from "../registry/subagent-child-owner-match.js";
import { matchesSubagentKillIntent } from "../registry/subagent-control-kill-intent.js";
import type { SubagentKillSession } from "../registry/subagent-control-session.js";
import {
  clearDeliveryState,
  ensureCompletionState,
  markRequesterSettleWakePending,
  recordRequesterHandoff,
} from "../registry/subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "../registry/subagent-lifecycle-events.js";
import { resolveKilledSubagentTaskEndedAt } from "../registry/subagent-registry-completion.js";
import { updateSubagentArchiveAtMs } from "../registry/subagent-registry-helpers.js";
import type {
  CleanupBookkeepingParams,
  SubagentLifecycleCompletionContext,
} from "../registry/subagent-registry-lifecycle-context.js";
import type { captureSubagentRunResult } from "../registry/subagent-registry-lifecycle-delivery.js";
import { SubagentRegistryMutationRejectedError } from "../registry/subagent-registry-persistence.js";
import { isCompletionHeldByYield } from "../registry/subagent-registry-run-pause.js";
import type {
  SubagentCompletionRequest,
  SubagentRunRecord,
} from "../registry/subagent-registry.types.js";
import {
  hasRequesterTurnYielded,
  isSubagentPausedByYield,
} from "../registry/subagent-requester-turn-custody.js";
import { isClaimedByLiveRequesterTurn } from "../registry/subagent-requester-turn-liveness.js";
import { getSubagentTerminalReplySummary } from "../registry/subagent-run-payload-facts.js";
import {
  resolveSubagentRunEffectiveEndedAt,
  shouldPreservePublishedExplicitRunTimeout,
} from "../registry/subagent-run-timeout.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { isSwarmRunActive } from "../swarm/swarm-scheduler.js";

const MISSING_REQUIRED_FINAL_REPLY_ERROR = "subagent run ended before producing a final reply";

function resolveTerminalRequest(
  entry: SubagentRunRecord,
  completeParams: SubagentCompletionRequest,
  now: number,
  liveStructuredOutput: SubagentRunRecord["structuredOutput"],
) {
  let completionReason = completeParams.reason;
  let requestedEndedAt = completeParams.endedAt ?? now;
  const existingEndedAt = entry.execution.endedAt;
  const previousOutcome = entry.execution.outcome;
  const olderEquivalent =
    typeof existingEndedAt === "number" &&
    requestedEndedAt < existingEndedAt &&
    entry.endedReason === completeParams.reason &&
    previousOutcome?.status === completeParams.outcome.status &&
    (previousOutcome.status !== "error" || previousOutcome.error === completeParams.outcome.error);
  // Preserve the newer canonical timing while allowing this duplicate
  // caller to rescue a stalled cleanup and delivery tail.
  const drainedEndedAt =
    typeof existingEndedAt === "number" && olderEquivalent ? existingEndedAt : undefined;
  const shouldDrainExistingTerminal = drainedEndedAt !== undefined;
  if (drainedEndedAt !== undefined) {
    requestedEndedAt = drainedEndedAt;
    completionReason = entry.endedReason ?? completeParams.reason;
  }
  let endedAt = requestedEndedAt;
  let completionOutcome =
    shouldDrainExistingTerminal && entry.execution.outcome
      ? entry.execution.outcome
      : completeParams.outcome;
  if (
    liveStructuredOutput?.structured !== undefined &&
    completionOutcome.status === "error" &&
    completionOutcome.error === "completed"
  ) {
    // Tool-only collector turns use this runner sentinel after the result is
    // durably recorded. Normalize before every task/session/hook projection.
    completionOutcome = { status: "ok" };
    completionReason = SUBAGENT_ENDED_REASON_COMPLETE;
  }
  const observedStartedAt =
    !shouldDrainExistingTerminal &&
    typeof completeParams.startedAt === "number" &&
    Number.isFinite(completeParams.startedAt)
      ? completeParams.startedAt
      : undefined;
  const effectiveEndedAt = resolveSubagentRunEffectiveEndedAt(entry, endedAt, observedStartedAt);
  if (effectiveEndedAt < endedAt) {
    endedAt = effectiveEndedAt;
    completionOutcome = { status: "timeout" };
    completionReason = SUBAGENT_ENDED_REASON_COMPLETE;
  }
  // Reply evidence follows producer order; duplicate receipts may still drain cleanup.
  const terminalReply = mergeAgentRunTerminalReplySnapshot(
    entry.completion?.terminalReply,
    entry.completion?.terminalReply &&
      typeof existingEndedAt === "number" &&
      (completeParams.endedAt ?? now) <= existingEndedAt
      ? undefined
      : completeParams.terminalReply,
  );
  return {
    requestedEndedAt,
    endedAt,
    completionOutcome,
    completionReason,
    observedStartedAt,
    terminalReply,
    missingRequiredReply: entry.expectsCompletionMessage === true && !terminalReply,
  };
}

function prepareTerminalCompletion(
  context: SubagentLifecycleCompletionContext,
  entry: SubagentRunRecord,
  request: SubagentCompletionRequest,
  now: number,
  structuredOutput: SubagentRunRecord["structuredOutput"],
) {
  const terminal = resolveTerminalRequest(entry, request, now, structuredOutput);
  return {
    captureOutcome: withSubagentOutcomeTiming(terminal.completionOutcome, {
      startedAt: terminal.observedStartedAt ?? entry.execution.startedAt,
      endedAt: terminal.endedAt,
    }),
    captureRequired: !(
      context.newerGenerationOwnsSession(entry) ||
      terminal.terminalReply ||
      getSubagentTerminalReplySummary(entry) ||
      (terminal.missingRequiredReply && terminal.completionOutcome.status === "ok") ||
      request.completionSnapshot
    ),
  };
}

function recordTerminalExecution(
  entry: SubagentRunRecord,
  outcome: SubagentCompletionRequest["outcome"],
  reason: SubagentCompletionRequest["reason"],
  endedAt: number,
  suppressSessionEffects: SubagentRunRecord["execution"]["suppressSessionEffects"],
) {
  const timedOutcome = withSubagentOutcomeTiming(outcome, {
    startedAt: entry.execution.startedAt,
    endedAt,
  });
  // Lifecycle events and agent.wait can report the same terminal facts.
  const executionOutcome =
    isDeepStrictEqual(entry.execution.outcome, timedOutcome) && entry.execution.outcome
      ? entry.execution.outcome
      : timedOutcome;
  if (
    entry.execution.status !== "terminal" ||
    entry.execution.endedAt !== endedAt ||
    entry.execution.outcome !== executionOutcome ||
    entry.execution.suppressSessionEffects !== suppressSessionEffects
  ) {
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: executionOutcome,
      suppressSessionEffects,
    };
  }
  entry.endedReason = reason;
  return executionOutcome;
}

function planTerminalCompletion(
  context: SubagentLifecycleCompletionContext,
  completeParams: SubagentCompletionRequest,
  currentEntry: SubagentRunRecord,
  prepared: {
    now: number;
    suppressSessionEffects: boolean;
    structuredOutput: SubagentRunRecord["structuredOutput"];
    capture: Awaited<ReturnType<typeof captureSubagentRunResult>>;
    collectorSession?: SubagentKillSession;
  },
) {
  const params = context.options;
  if (isCompletionHeldByYield(currentEntry, completeParams)) {
    return undefined;
  }
  const entry = structuredClone(currentEntry);
  let suppressSessionEffects =
    prepared.suppressSessionEffects || entry.execution.suppressSessionEffects === true;
  let replacedProvisionalKill = false;
  if (
    entry.execution.suppressSessionEffects === true &&
    (entry.execution.status === "terminal" ||
      resolveSubagentChildAuthority(entry).status !== "legacy-unverified") &&
    entry.killIntent === undefined
  ) {
    return undefined;
  }
  const sessionSuperseded = context.newerGenerationOwnsSession(currentEntry);
  if (
    completeParams.reason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.killIntent === undefined &&
    entry.endedReason !== undefined &&
    entry.execution.outcome !== undefined &&
    (entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
      (entry.execution.status === "terminal" &&
        entry.killReconciliation === undefined &&
        entry.pauseReason === undefined &&
        typeof entry.execution.endedAt === "number" &&
        Number.isFinite(entry.execution.endedAt)))
  ) {
    // A delayed abort must not replace a finalized result or reopen a confirmed cancellation.
    return undefined;
  }
  if (shouldPreservePublishedExplicitRunTimeout(entry)) {
    return undefined;
  }
  const liveStructuredOutput = entry.collect
    ? (entry.structuredOutput ?? prepared.structuredOutput)
    : undefined;
  if (!entry.structuredOutput && liveStructuredOutput) {
    entry.structuredOutput = liveStructuredOutput;
  }
  const {
    requestedEndedAt,
    endedAt,
    observedStartedAt,
    terminalReply,
    missingRequiredReply,
    ...terminal
  } = resolveTerminalRequest(entry, completeParams, prepared.now, liveStructuredOutput);
  let { completionOutcome, completionReason } = terminal;
  const killIntent = entry.killIntent;
  if (killIntent) {
    if (completionReason !== SUBAGENT_ENDED_REASON_KILLED && endedAt < killIntent.requestedAt) {
      entry.killIntent = undefined;
    } else {
      const killOwnsCurrentLifecycle =
        killIntent.lifecycleGeneration !== undefined &&
        isAgentEventLifecycleGenerationCurrent(killIntent.lifecycleGeneration);
      completionReason = SUBAGENT_ENDED_REASON_KILLED;
      completionOutcome = { status: "error", error: killIntent.reason };
      entry.killIntent = undefined;
      if (
        killOwnsCurrentLifecycle &&
        resolveSubagentChildAuthority(entry).status === "verified" &&
        entry.execution.suppressSessionEffects !== true
      ) {
        suppressSessionEffects = false;
        entry.execution = {
          ...entry.execution,
          lifecycleGeneration: killIntent.lifecycleGeneration,
          suppressSessionEffects: undefined,
        };
      }
      entry.killReconciliation = {
        killedAt: killIntent.requestedAt,
        taskCancellationAccepted: killOwnsCurrentLifecycle ? true : undefined,
        suppressTaskDelivery: killIntent.suppressTaskDelivery === true ? true : undefined,
      };
    }
  }
  if (
    completionReason !== SUBAGENT_ENDED_REASON_KILLED &&
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.killReconciliation === undefined
  ) {
    // Only current-version provisional kills carry reconciliation state.
    // Legacy or already-stabilized killed rows are terminal cancellation.
    return undefined;
  }
  const isSteerRestartKill =
    completeParams.reason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.suppressAnnounceReason === "steer-restart";
  if (completionReason === SUBAGENT_ENDED_REASON_KILLED && !isSteerRestartKill) {
    entry.suppressAnnounceReason = "killed";
    entry.killReconciliation ??= {
      killedAt: requestedEndedAt,
    };
  }

  if (
    completionReason !== SUBAGENT_ENDED_REASON_KILLED &&
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.killReconciliation !== undefined
  ) {
    const killReconciliation = entry.killReconciliation;
    const stableTaskCancellation = killReconciliation.taskCancellationAccepted === true;
    const cancellationEndedAt = resolveKilledSubagentTaskEndedAt(entry);
    const completionPredatesCancellation =
      typeof cancellationEndedAt === "number" && endedAt < cancellationEndedAt;
    if (stableTaskCancellation && !completionPredatesCancellation) {
      // Native cancellation promotes the provisional marker to durable operator
      // intent. Only an already-durable earlier completion may reopen it.
      return undefined;
    }
    replacedProvisionalKill = true;
    entry.suppressCompletionDelivery =
      killReconciliation.suppressTaskDelivery === true ? true : undefined;
    entry.suppressAnnounceReason = undefined;
    entry.killReconciliation = undefined;
    entry.cleanupHandled = false;
    entry.cleanupCompletedAt = undefined;
    clearDeliveryState(entry);
  }

  if (observedStartedAt !== undefined && entry.execution.startedAt !== observedStartedAt) {
    entry.execution = { ...entry.execution, startedAt: observedStartedAt };
    if (typeof entry.sessionStartedAt !== "number") {
      entry.sessionStartedAt = observedStartedAt;
    }
  }

  if (
    completionReason === SUBAGENT_ENDED_REASON_COMPLETE &&
    completionOutcome.status !== "error" &&
    replacedProvisionalKill
  ) {
    // A killed lifecycle may freeze an empty result before the canonical end
    // wins. Preserve any reply already captured by an earlier successful callback.
    const completion = ensureCompletionState(entry);
    const hasCapturedReply =
      typeof completion.resultText === "string" && completion.resultText.trim().length > 0;
    if (
      !hasCapturedReply &&
      (completion.resultText !== undefined || completion.capturedAt !== undefined)
    ) {
      completion.resultText = undefined;
      completion.capturedAt = undefined;
    }
  }
  // Lifecycle events and agent.wait both settle here. A required success
  // needs producer evidence before any transcript fallback can freeze it.
  if (missingRequiredReply && completionOutcome.status === "ok") {
    // An unproven success cannot replace the cancellation already owned by this run.
    if (replacedProvisionalKill) {
      return undefined;
    }
    completionOutcome = { status: "error", error: MISSING_REQUIRED_FINAL_REPLY_ERROR };
    completionReason = SUBAGENT_ENDED_REASON_ERROR;
  }
  const executionOutcome = recordTerminalExecution(
    entry,
    completionOutcome,
    completionReason,
    endedAt,
    suppressSessionEffects ? true : undefined,
  );
  entry.waitForMessage = undefined;
  if (entry.pauseReason !== undefined) {
    entry.pauseReason = undefined;
  }

  const completion = ensureCompletionState(entry);
  if (completeParams.completionSnapshot) {
    completion.resultText = completeParams.completionSnapshot.resultText;
    completion.capturedAt = completeParams.completionSnapshot.capturedAt;
  }

  if (
    terminalReply &&
    (JSON.stringify(terminalReply) !== JSON.stringify(completion.terminalReply) ||
      completion.resultText === undefined)
  ) {
    completion.terminalReply = terminalReply;
    completion.resultText =
      terminalReply.disposition === "visible"
        ? terminalReply.text
        : terminalReply.disposition === "silent"
          ? SILENT_REPLY_TOKEN
          : null;
    completion.capturedAt = endedAt;
  }

  const closesAsIntentionalNonDelivery =
    entry.expectsCompletionMessage === true &&
    executionOutcome.status === "ok" &&
    terminalReply?.disposition === "empty" &&
    terminalReply.code !== "message-tool-not-called" &&
    !hasRequesterTurnYielded(entry) &&
    entry.requesterSettleWake === undefined;
  if (closesAsIntentionalNonDelivery) {
    // Producer-owned empty success is a terminal fact, not a failed send.
    // Close it before terminal persistence so no requester delivery can start.
    entry.delivery = { status: "not_required" };
    entry.suppressCompletionDelivery = true;
  }

  if (completion.resultText === undefined) {
    if (sessionSuperseded || executionOutcome.status === "error") {
      completion.resultText = null;
      completion.capturedAt = prepared.now;
    } else {
      const capture = prepared.capture;
      if (
        !capture ||
        !isDeepStrictEqual(entry.execution.transcriptTarget, capture.transcriptTarget) ||
        !isDeepStrictEqual(executionOutcome, capture.outcome)
      ) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent completion requires fresh result capture",
        );
      }
      completion.resultText = capture.resultText;
      completion.capturedAt = capture.capturedAt;
    }
  }
  if (entry.collect) {
    updateSwarmCollectorCompletion(
      entry,
      params.getRuntimeConfig(),
      { entry: prepared.collectorSession?.entry },
      // Mark only the sweeper's diagnostic settlement of a yield with no recorded outcome.
      completeParams.settleYielded === true && currentEntry.execution.outcome === undefined
        ? "yielded_without_result"
        : undefined,
    );
  } else {
    updateSubagentArchiveAtMs(entry, params.getRuntimeConfig());
  }
  const delivery = entry.delivery;
  if (
    delivery?.payload &&
    delivery.status !== "delivered" &&
    typeof delivery.announcedAt !== "number"
  ) {
    delivery.payload = {
      ...delivery.payload,
      startedAt: entry.execution.startedAt,
      endedAt: entry.execution.endedAt,
      outcome: entry.execution.outcome,
      terminalReply: entry.completion?.terminalReply,
    };
  }
  if (
    entry.completionTarget === "parent" &&
    entry.delivery?.status === "pending" &&
    !entry.delivery.requesterDelivery &&
    isClaimedByLiveRequesterTurn(entry)
  ) {
    recordRequesterHandoff(entry, entry.requesterTurnRunId);
  }
  const mutated = !isDeepStrictEqual(currentEntry, entry);
  const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
  const provisionalKill = entry.killReconciliation !== undefined;
  return {
    entry: mutated ? entry : currentEntry,
    completionReason,
    mutated,
    sessionSuperseded,
    suppressSessionEffects,
    replacedProvisionalKill,
    effects: {
      terminalSignalOutcome:
        mutated &&
        !suppressSessionEffects &&
        !sessionSuperseded &&
        !provisionalKill &&
        executionOutcome.status !== "unknown"
          ? executionOutcome.status
          : undefined,
      retireSuperseded: completionReason !== SUBAGENT_ENDED_REASON_KILLED,
      releaseSwarm: entry.collect === true,
      persistTiming: mutated,
      publishStatus: mutated && !suppressedForSteerRestart,
      publishProgress: !provisionalKill,
      endedHook: !suppressedForSteerRestart && !provisionalKill,
      deferEndedHook: completeParams.triggerCleanup && entry.expectsCompletionMessage === true,
      cleanup: completeParams.triggerCleanup && !suppressedForSteerRestart,
      retireMcp: entry.spawnMode !== "session",
      cleanupTail: provisionalKill ? ("confirm-kill" as const) : ("announce" as const),
    },
  };
}

function planTerminalTermination(
  currentEntry: SubagentRunRecord,
  params: {
    now: number;
    reason: string;
    getRuntimeConfig(): OpenClawConfig;
    suppressSessionEffects?: boolean;
    suppressTaskDelivery?: boolean;
    killClaim?: NonNullable<SubagentRunRecord["killIntent"]>;
    session?: SubagentKillSession;
  },
) {
  const { now, reason } = params;
  const entry = structuredClone(currentEntry);
  const wasKilledLifecycle =
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED && entry.killReconciliation !== undefined;
  const existingKillReconciliation = entry.killReconciliation;
  const existingKillIntent = entry.killIntent;
  if (
    params.killClaim &&
    !matchesSubagentKillIntent(existingKillIntent, params.killClaim) &&
    !(
      existingKillReconciliation?.killedAt === params.killClaim.requestedAt &&
      existingKillReconciliation.taskCancellationAccepted === true
    )
  ) {
    return undefined;
  }
  const currentKillLifecycle =
    existingKillIntent?.lifecycleGeneration !== undefined &&
    isAgentEventLifecycleGenerationCurrent(existingKillIntent.lifecycleGeneration);
  if (
    typeof entry.execution.endedAt === "number" &&
    !isSubagentPausedByYield(entry) &&
    !wasKilledLifecycle
  ) {
    // An abort lifecycle event can mark the run killed before this shared
    // termination path runs. Re-enter only for that provisional state so
    // it receives the same reconciliation tombstone as a direct kill.
    return undefined;
  }
  const wasYielded = isSubagentPausedByYield(entry);
  const wasQueuedCollector = entry.collect && entry.execution.status === "queued";
  const collectorLaunchInFlight =
    wasQueuedCollector &&
    entry.swarmLaunchPending === true &&
    isSwarmRunActive(entry.schedulerSlotId ?? entry.runId);
  const endedAt =
    (wasYielded || wasKilledLifecycle) && typeof entry.execution.endedAt === "number"
      ? entry.execution.endedAt
      : now;
  if (existingKillIntent && currentKillLifecycle) {
    entry.execution.lifecycleGeneration = existingKillIntent.lifecycleGeneration;
  }
  recordTerminalExecution(
    entry,
    { status: "error", error: reason },
    SUBAGENT_ENDED_REASON_KILLED,
    endedAt,
    params.suppressSessionEffects ||
      resolveSubagentChildAuthority(entry).status === "legacy-unverified"
      ? true
      : existingKillIntent && currentKillLifecycle
        ? undefined
        : entry.execution.suppressSessionEffects,
  );
  entry.cleanupHandled = true;
  entry.cleanupCompletedAt = existingKillReconciliation
    ? (entry.cleanupCompletedAt ?? endedAt)
    : now;
  entry.suppressAnnounceReason = "killed";
  entry.pauseReason = undefined;
  entry.killIntent = undefined;
  const taskEndedAt = existingKillIntent
    ? existingKillIntent.requestedAt
    : existingKillReconciliation
      ? (resolveKilledSubagentTaskEndedAt(entry) ?? endedAt)
      : wasYielded
        ? now
        : endedAt;
  entry.killReconciliation = {
    killedAt:
      existingKillIntent?.requestedAt ?? existingKillReconciliation?.killedAt ?? taskEndedAt,
    taskCancellationAccepted:
      existingKillIntent || existingKillReconciliation?.taskCancellationAccepted === true
        ? true
        : undefined,
    suppressTaskDelivery:
      existingKillIntent?.suppressTaskDelivery === true ||
      existingKillReconciliation?.suppressTaskDelivery === true ||
      params.suppressTaskDelivery === true
        ? true
        : undefined,
    supersededAt: existingKillReconciliation?.supersededAt,
  };
  if (wasQueuedCollector && !collectorLaunchInFlight) {
    const session = params.session;
    session?.assertCurrent();
    updateSwarmCollectorCompletion(entry, params.getRuntimeConfig(), {
      entry: session?.entry,
    });
  } else if (!entry.collect) {
    updateSubagentArchiveAtMs(entry, params.getRuntimeConfig());
  }
  return { entry, withdrawQueuedCollector: Boolean(wasQueuedCollector) };
}

function planCleanupBookkeeping(
  entry: SubagentRunRecord,
  params: CleanupBookkeepingParams,
  suppressSessionEffects: boolean,
) {
  const isDeleteCleanup = !params.provisionalKill && params.cleanup === "delete";
  // Cron reads settled rows until archive; expired discards have no remaining reader.
  const retireAfterSettle =
    !params.provisionalKill &&
    !entry.collect &&
    ((isDeleteCleanup &&
      (!isCronRunSessionKey(entry.requesterSessionKey) ||
        (entry.delivery?.status === "discarded" && entry.delivery.discardReason === "expired"))) ||
      (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        entry.suppressAnnounceReason !== "killed"));
  const retireImmediately =
    retireAfterSettle &&
    params.skipRequesterSettleWake === true &&
    params.retainForCleanup !== true;
  const wakeRequester =
    !params.provisionalKill && !entry.collect && !params.skipRequesterSettleWake;
  if (!params.provisionalKill && !retireImmediately) {
    entry.cleanupCompletedAt = params.completedAt;
    if (suppressSessionEffects) {
      entry.execution.suppressSessionEffects = true;
    }
    if (entry.collect) {
      entry.requesterSettleWake = undefined;
    } else if (wakeRequester) {
      if (retireAfterSettle) {
        entry.retireAfterSettle = true;
      }
      markRequesterSettleWakePending(entry);
    }
  }
  return {
    retireImmediately,
    retireAfterSettle,
    wakeRequester,
    retireBinding:
      !params.provisionalKill &&
      (retireImmediately || Boolean(entry.collect) || Boolean(params.skipRequesterSettleWake)),
    clearPendingError: isDeleteCleanup || retireAfterSettle,
    removeTranscript: !params.preserveTranscript,
    retireMcp: entry.spawnMode !== "session",
    contextEndedReason:
      !params.provisionalKill && (isDeleteCleanup || !entry.collect)
        ? isDeleteCleanup
          ? ("deleted" as const)
          : ("completed" as const)
        : undefined,
  };
}

function planCompletionRetry(
  entry: SubagentRunRecord | undefined,
  params: SubagentCompletionRequest,
): { kind: "none" } | { kind: "completion" | "cleanup"; entry: SubagentRunRecord } {
  if (entry && typeof entry.execution.endedAt !== "number") {
    // Retain live result evidence until the terminal row is durably published.
    return { kind: "completion", entry };
  }
  if (!entry || typeof entry.cleanupCompletedAt === "number" || isSubagentPausedByYield(entry)) {
    return { kind: "none" };
  }
  // A collector has no announce tail to retry terminal resource cleanup.
  const retryCompletion =
    entry.collect &&
    entry.collectorCompletion &&
    params.triggerCleanup &&
    entry.execution.suppressSessionEffects !== true &&
    entry.browserCleanupDispatchedAt === undefined;
  return { kind: retryCompletion ? "completion" : "cleanup", entry };
}

// The transition owner decides row changes and owed work. Adapters own publication and dispatch.
export const subagentTerminalTransition = {
  prepare: prepareTerminalCompletion,
  complete: planTerminalCompletion,
  terminate: planTerminalTermination,
  cleanup: planCleanupBookkeeping,
  retry: planCompletionRetry,
};
