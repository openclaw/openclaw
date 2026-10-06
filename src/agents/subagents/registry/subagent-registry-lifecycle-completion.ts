import { isDeepStrictEqual } from "node:util";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { captureSessionWatcherStorePaths } from "../../../config/sessions/session-store-path.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { prepareSubagentTerminalState } from "../../../sessions/subagent-terminal-state.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { mergeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { peekSwarmStructuredOutput } from "../../tools/structured-output-tool.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import {
  clearPublishedSwarmCollectorOutput,
  updateSwarmCollectorCompletion,
} from "../swarm/swarm-collector.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import { clearDeliveryState, ensureCompletionState } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { resolveKilledSubagentTaskEndedAt } from "./subagent-registry-completion.js";
import { updateSubagentArchiveAtMs } from "./subagent-registry-helpers.js";
import type { SubagentLifecycleCompletionContext } from "./subagent-registry-lifecycle-context.js";
import { captureSubagentRunResult } from "./subagent-registry-lifecycle-delivery.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { completeTerminalEffects } from "./subagent-registry-terminal-effects.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRunOwner } from "./subagent-run-generation.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";

const MISSING_REQUIRED_FINAL_REPLY_ERROR = "subagent run ended before producing a final reply";

const browserCleanupLoader = createLazyImportLoader(
  () => import("../../../browser-lifecycle-cleanup.js"),
);

function shouldPreservePublishedExplicitRunTimeout(entry: SubagentRunRecord): boolean {
  if (
    entry.execution.outcome?.status !== "timeout" ||
    typeof entry.execution.endedAt !== "number"
  ) {
    return false;
  }
  const deadlineMs = resolveSubagentRunDeadlineMs(entry);
  if (deadlineMs === undefined || entry.execution.endedAt < deadlineMs) {
    return false;
  }
  return (
    entry.cleanupHandled === true ||
    typeof entry.cleanupCompletedAt === "number" ||
    typeof entry.endedHookEmittedAt === "number" ||
    entry.delivery?.status === "delivered" ||
    typeof entry.delivery?.announcedAt === "number"
  );
}

function resolveTerminalRequest(
  entry: SubagentRunRecord,
  completeParams: SubagentCompletionRequest,
  now: number,
  liveStructuredOutput: SubagentRunRecord["structuredOutput"],
) {
  const recoveryRequested = completeParams.recoverInterrupted === true;
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
    typeof existingEndedAt === "number" && (recoveryRequested || olderEquivalent)
      ? existingEndedAt
      : undefined;
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
  const effectiveEndedAt = recoveryRequested
    ? endedAt
    : resolveSubagentRunEffectiveEndedAt(entry, endedAt, observedStartedAt);
  if (effectiveEndedAt < endedAt) {
    endedAt = effectiveEndedAt;
    completionOutcome = { status: "timeout" };
    completionReason = SUBAGENT_ENDED_REASON_COMPLETE;
  }
  const terminalReply = mergeAgentRunTerminalReplySnapshot(
    entry.completion?.terminalReply,
    completeParams.terminalReply,
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

export async function completeSubagentRunAttempt(
  context: SubagentLifecycleCompletionContext,
  completeParams: SubagentCompletionRequest,
): Promise<void> {
  const params = context.options;
  const stateContext = captureOpenClawStateWorkerContext();
  const selectedOwner = completeParams.expectedEntry
    ? getCurrentSubagentRunOwner(params.runs, completeParams.expectedEntry)
    : params.runs.get(completeParams.runId);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  if (!selectedOwner) {
    return;
  }
  let releaseCompletionLock: (() => void) | undefined = await context.acquireTerminalCompletionLock(
    selectedOwner.runId,
  );
  let collectorSession: SubagentKillSession | undefined;
  const selected = getCurrentSubagentRunOwner(params.runs, selectedOwner);
  if (!selected) {
    releaseCompletionLock();
    throw new SubagentRegistryMutationRejectedError("Subagent terminal execution changed");
  }
  try {
    const assertCurrent = () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      if (
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
        !getCurrentSubagentRunOwner(params.runs, selected) ||
        completeParams.recoveryCurrent?.isHostCurrent() === false
      ) {
        throw new SubagentRegistryMutationRejectedError("Subagent terminal execution changed");
      }
    };
    const selectedEffects = context.getSessionEffects(selected);
    const assertSessionBinding = () => {
      const current = context.getSessionEffects(selected);
      if (current !== selectedEffects && current !== completeParams.sessionEffects) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent terminal session-effects binding changed",
        );
      }
    };
    const suppressSessionEffects =
      completeParams.suppressSessionEffects === true ||
      (await context.shouldSuppressSessionEffects(selected, completeParams.sessionEffects));
    if (completeParams.recoveryCurrent && !(await completeParams.recoveryCurrent.prepare())) {
      return;
    }
    assertCurrent();
    assertSessionBinding();
    if (selected.collect && !selected.collectorCompletion) {
      collectorSession = await prepareSubagentKillSession(
        params.getRuntimeConfig(),
        selected.childSessionKey,
        assertCurrent,
        selected.execution.transcriptTarget,
        selected.childAgentId,
      );
    }
    const now = Date.now();
    const structuredOutput = selected.collect
      ? (selected.structuredOutput ??
        peekSwarmStructuredOutput(selected.runId) ??
        (selected.swarmRunId ? peekSwarmStructuredOutput(selected.swarmRunId) : undefined))
      : undefined;
    const terminal = resolveTerminalRequest(selected, completeParams, now, structuredOutput);
    const captureOutcome = withSubagentOutcomeTiming(terminal.completionOutcome, {
      startedAt: terminal.observedStartedAt ?? selected.execution.startedAt,
      endedAt: terminal.endedAt,
    });
    const prepared = {
      now,
      childAgentId: resolveSubagentChildSessionOwner(selected, params.getRuntimeConfig()).agentId,
      watcherStorePaths: captureSessionWatcherStorePaths([selected.requesterSessionKey]),
      suppressSessionEffects,
      structuredOutput,
      capture:
        completeParams.recoverInterrupted ||
        context.newerGenerationOwnsSession(selected) ||
        terminal.terminalReply ||
        (terminal.missingRequiredReply && terminal.completionOutcome.status === "ok") ||
        completeParams.completionSnapshot
          ? undefined
          : await captureSubagentRunResult(context, selected, captureOutcome, assertCurrent),
      collectorSession,
    };
    assertCurrent();
    let settled: ReturnType<typeof planTerminalCompletion>;
    let terminalGeneration = 0;
    let publishesTerminalSignal = false;
    try {
      const commit = () =>
        mutateSubagentRuns(
          [selected.runId],
          (rows) => {
            const current = rows.get(selected.runId);
            if (
              !current ||
              !isSameSubagentRunOwner(current, selected) ||
              current.requesterSessionKey !== selected.requesterSessionKey
            ) {
              throw new SubagentRegistryMutationRejectedError(
                "Subagent terminal execution changed",
              );
            }
            assertSessionBinding();
            const planned = planTerminalCompletion(context, completeParams, current, prepared);
            if (!planned) {
              return { value: undefined };
            }
            const entry = planned.entry;
            const outcomeStatus = entry.execution.outcome?.status;
            const terminalEvents =
              !planned.suppressSessionEffects &&
              !planned.sessionSuperseded &&
              entry.killReconciliation === undefined &&
              outcomeStatus &&
              outcomeStatus !== "unknown"
                ? [
                    prepareSubagentTerminalState(
                      {
                        childSessionKey: entry.childSessionKey,
                        agentId: prepared.childAgentId,
                        runId: entry.runId,
                        requesterSessionKey: entry.requesterSessionKey,
                        outcomeStatus,
                        watcherStorePaths: prepared.watcherStorePaths,
                        sessionEntryCurrent: (
                          completeParams.sessionEffects ?? context.getSessionEffects(current)
                        )?.nativeCheck,
                      },
                      prepared.now,
                    ),
                  ]
                : undefined;
            publishesTerminalSignal = terminalEvents !== undefined;
            return {
              value: planned,
              postimages: planned.mutated ? new Map([[entry.runId, entry]]) : undefined,
              terminalEvents,
            };
          },
          {
            runs: params.runs,
            context: stateContext,
            onPublished: (postimages, planned) => {
              if (planned) {
                const published = postimages.get(planned.entry.runId) ?? planned.entry;
                completeParams.recoveryCurrent?.onPublished?.(published);
                clearPublishedSwarmCollectorOutput(published);
              }
            },
            assertCurrent: () => {
              assertCurrent();
              assertSessionBinding();
              collectorSession?.assertCurrent();
              if (publishesTerminalSignal && context.newerGenerationOwnsSession(selected)) {
                throw new SubagentRegistryMutationRejectedError(
                  "Subagent terminal signal session changed",
                );
              }
              if (!suppressSessionEffects) {
                (
                  completeParams.sessionEffects ?? context.getSessionEffects(selected)
                )?.assertHostCurrent();
              }
            },
          },
        );
      settled = collectorSession ? await collectorSession.withPublication(commit) : await commit();
      if (settled) {
        const bindingChanged =
          completeParams.sessionEffects !== undefined &&
          context.getSessionEffects(settled.entry) !== completeParams.sessionEffects;
        context.bindTerminalSessionEffects(settled.entry, completeParams.sessionEffects);
        terminalGeneration = context.bumpTerminalGeneration(settled.entry, bindingChanged);
        if (settled.replacedProvisionalKill) {
          context.bumpCleanupGeneration(settled.entry);
        }
        const published = getCurrentSubagentRunOwner(params.runs, settled.entry);
        if (published) {
          params.clearPendingLifecycleError(published.runId);
        }
      }
    } finally {
      releaseCompletionLock?.();
      releaseCompletionLock = undefined;
    }
    if (!settled) {
      return;
    }
    await completeTerminalEffects(context, {
      completeParams,
      ...settled,
      terminalGeneration,
      stateContext,
      assertCurrent,
      loadCleanupBrowserSessionsForLifecycleEnd:
        params.loadCleanupBrowserSessionsForLifecycleEnd ??
        (async () => (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd),
    });
  } finally {
    releaseCompletionLock?.();
    await collectorSession?.release();
  }
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
  if (
    currentEntry.pauseReason === "sessions_yield" &&
    completeParams.reason !== SUBAGENT_ENDED_REASON_KILLED
  ) {
    return undefined;
  }
  const entry = structuredClone(currentEntry);
  let suppressSessionEffects =
    prepared.suppressSessionEffects || entry.execution.suppressSessionEffects === true;
  let replacedProvisionalKill = false;
  const recoveryRequested = completeParams.recoverInterrupted === true;
  if (
    !recoveryRequested &&
    (entry.terminalOwner === "interrupted-recovery" ||
      entry.execution.suppressSessionEffects === true) &&
    entry.killIntent === undefined
  ) {
    // Restart recovery already persisted the terminal winner for this exact
    // run. Its sticky fence survives cleanup of the transient owner marker.
    return undefined;
  }
  if (recoveryRequested) {
    const ownsInterruptedRecovery = entry.terminalOwner === "interrupted-recovery";
    // Mismatched partial terminal evidence is an existing winner and must
    // not be overwritten. Exact normalized evidence may be the same recovery
    // request deferred by restart admission, so drain it.
    const hasTerminalEvidence =
      entry.execution.status === "terminal" ||
      entry.endedReason !== undefined ||
      typeof entry.cleanupCompletedAt === "number";
    const expectedElapsedMs =
      typeof currentEntry.execution.startedAt === "number" &&
      typeof completeParams.endedAt === "number"
        ? Math.max(0, completeParams.endedAt - currentEntry.execution.startedAt)
        : undefined;
    const outcomeMatchesInterruptedRecovery = (outcome: SubagentRunOutcome | undefined) =>
      completeParams.outcome.status === "error" &&
      outcome?.status === "error" &&
      outcome.error === completeParams.outcome.error &&
      (outcome.startedAt === undefined || outcome.startedAt === currentEntry.execution.startedAt) &&
      (outcome.endedAt === undefined || outcome.endedAt === completeParams.endedAt) &&
      (outcome.elapsedMs === undefined || outcome.elapsedMs === expectedElapsedMs);
    const matchesRequestedInterruptedTerminal =
      typeof completeParams.endedAt === "number" &&
      entry.execution.endedAt === completeParams.endedAt &&
      outcomeMatchesInterruptedRecovery(entry.execution.outcome) &&
      entry.endedReason === SUBAGENT_ENDED_REASON_ERROR;
    if (
      !ownsInterruptedRecovery &&
      (entry.killReconciliation !== undefined ||
        entry.endedReason === SUBAGENT_ENDED_REASON_KILLED ||
        entry.pauseReason === "sessions_yield" ||
        typeof entry.cleanupCompletedAt === "number" ||
        (hasTerminalEvidence && !matchesRequestedInterruptedTerminal))
    ) {
      return undefined;
    }
    if (!ownsInterruptedRecovery) {
      const endedAt = completeParams.endedAt ?? prepared.now;
      const outcome = withSubagentOutcomeTiming(
        { status: "error", error: completeParams.outcome.error },
        { startedAt: entry.execution.startedAt, endedAt },
      );
      entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
      entry.pauseReason = undefined;
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt,
        outcome,
        interruptedAt: undefined,
        interruptionReason: "gateway-restart",
        suppressSessionEffects: suppressSessionEffects ? true : undefined,
      };
      entry.completion = {
        ...ensureCompletionState(entry),
        resultText: null,
        capturedAt: endedAt,
      };
      entry.cleanupHandled = false;
      entry.terminalOwner = "interrupted-recovery";
    }
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
        Number.isFinite(entry.execution.endedAt) &&
        typeof entry.cleanupCompletedAt === "number" &&
        Number.isFinite(entry.cleanupCompletedAt) &&
        entry.cleanupCompletedAt >= entry.execution.endedAt))
  ) {
    // A delayed abort must not replace a finalized result or reopen a cleaned cancellation.
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
      if (killOwnsCurrentLifecycle && entry.execution.suppressSessionEffects !== true) {
        suppressSessionEffects = false;
        entry.execution = {
          ...entry.execution,
          lifecycleGeneration: killIntent.lifecycleGeneration,
          restartRecovery: undefined,
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
  const outcome =
    recoveryRequested && entry.execution.outcome
      ? entry.execution.outcome
      : withSubagentOutcomeTiming(completionOutcome, {
          startedAt: entry.execution.startedAt,
          endedAt,
        });
  // Lifecycle events and agent.wait may report the same terminal facts. Keep
  // their authority stable while a prepared announcement waits for admission.
  const executionOutcome =
    (recoveryRequested || isDeepStrictEqual(entry.execution.outcome, outcome)) &&
    entry.execution.outcome
      ? entry.execution.outcome
      : outcome;
  const retainedRestartRecovery = suppressSessionEffects
    ? entry.execution.restartRecovery
    : undefined;
  const interruptionReason = recoveryRequested ? "gateway-restart" : undefined;
  if (
    entry.execution.status !== "terminal" ||
    entry.execution.endedAt !== endedAt ||
    entry.execution.outcome !== executionOutcome ||
    entry.execution.interruptionReason !== interruptionReason ||
    entry.execution.restartRecovery !== retainedRestartRecovery ||
    entry.execution.suppressSessionEffects !== (suppressSessionEffects ? true : undefined)
  ) {
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: executionOutcome,
      interruptedAt: undefined,
      interruptionReason,
      restartRecovery: retainedRestartRecovery,
      suppressSessionEffects: suppressSessionEffects ? true : undefined,
    };
  }
  entry.endedReason = completionReason;
  if (completionReason === SUBAGENT_ENDED_REASON_KILLED && entry.terminalOwner !== undefined) {
    entry.terminalOwner = undefined;
  }
  if (entry.pauseReason !== undefined) {
    entry.pauseReason = undefined;
  }

  if (completeParams.completionSnapshot) {
    const completion = ensureCompletionState(entry);
    completion.resultText = completeParams.completionSnapshot.resultText;
    completion.capturedAt = completeParams.completionSnapshot.capturedAt;
  }

  if (terminalReply) {
    const completion = ensureCompletionState(entry);
    if (
      JSON.stringify(terminalReply) !== JSON.stringify(completion.terminalReply) ||
      completion.resultText === undefined
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
  }

  const closesAsIntentionalNonDelivery =
    entry.expectsCompletionMessage === true &&
    executionOutcome.status === "ok" &&
    terminalReply?.disposition === "empty" &&
    terminalReply.code !== "message-tool-not-called" &&
    entry.requesterTurnYielded !== true &&
    entry.requesterSettleWake === undefined &&
    entry.delivery?.disposition !== "intentional_non_delivery";
  if (closesAsIntentionalNonDelivery) {
    // Producer-owned empty success is a terminal fact, not a failed send.
    // Close it before terminal persistence so no requester delivery can start.
    entry.delivery = {
      status: "not_required",
      disposition: "intentional_non_delivery",
    };
    entry.suppressCompletionDelivery = true;
  }

  const completion = ensureCompletionState(entry);
  if (completion.resultText === undefined) {
    if (recoveryRequested || sessionSuperseded || executionOutcome.status === "error") {
      completion.resultText = null;
      completion.capturedAt = prepared.now;
    } else if (prepared.capture) {
      if (
        !isDeepStrictEqual(entry.execution.transcriptTarget, prepared.capture.transcriptTarget) ||
        !isDeepStrictEqual(executionOutcome, prepared.capture.outcome)
      ) {
        throw new SubagentRegistryMutationRejectedError(
          "Subagent completion requires fresh result capture",
        );
      }
      completion.resultText = prepared.capture.resultText;
      completion.capturedAt = prepared.capture.capturedAt;
    } else {
      throw new SubagentRegistryMutationRejectedError(
        "Subagent completion requires fresh result capture",
      );
    }
  }
  if (entry.collect) {
    updateSwarmCollectorCompletion(entry, params.getRuntimeConfig(), {
      entry: prepared.collectorSession?.entry,
    });
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
  const mutated = !isDeepStrictEqual(currentEntry, entry);
  return {
    entry: mutated ? entry : currentEntry,
    completionReason,
    mutated,
    sessionSuperseded,
    suppressSessionEffects,
    replacedProvisionalKill,
  };
}
