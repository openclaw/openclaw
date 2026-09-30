import { isDeepStrictEqual } from "node:util";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { mergeAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { peekSwarmStructuredOutput } from "../../tools/structured-output-tool.js";
import { withSubagentOutcomeTiming } from "../announce/subagent-announce-output.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import { clearDeliveryState, ensureCompletionState } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { resolveKilledSubagentTaskEndedAt } from "./subagent-registry-completion.js";
import { updateSubagentArchiveAtMs } from "./subagent-registry-helpers.js";
import type { SubagentLifecycleCompletionContext } from "./subagent-registry-lifecycle-context.js";
import {
  freezeRunResultAtCompletion,
  refreshPendingFinalDeliveryPayload,
} from "./subagent-registry-lifecycle-delivery.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  captureSubagentRunMutationSnapshot,
  publishSubagentRunPostimages,
} from "./subagent-registry-persistence.js";
import { completeTerminalEffects } from "./subagent-registry-terminal-effects.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";

type BrowserCleanupModule = typeof import("../../../browser-lifecycle-cleanup.js");
type BrowserCleanup = BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"];

const MISSING_REQUIRED_FINAL_REPLY_ERROR = "subagent run ended before producing a final reply";

const browserCleanupLoader = createLazyImportLoader<BrowserCleanupModule>(
  () => import("../../../browser-lifecycle-cleanup.js"),
);

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<BrowserCleanup> {
  return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}

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

function isOlderEquivalentTerminalCallback(params: {
  entry: SubagentRunRecord;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
}): boolean {
  const current = params.entry.execution.outcome;
  if (
    typeof params.entry.execution.endedAt !== "number" ||
    params.endedAt >= params.entry.execution.endedAt ||
    params.entry.endedReason !== params.reason ||
    current?.status !== params.outcome.status
  ) {
    return false;
  }
  return current.status !== "error" || current.error === params.outcome.error;
}

export async function completeSubagentRunAttempt(
  context: SubagentLifecycleCompletionContext,
  completeParams: SubagentCompletionRequest,
): Promise<void> {
  const params = context.options;
  const stateContext = captureOpenClawStateWorkerContext();
  const selectedEntry = params.runs.get(completeParams.runId);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const selectedGeneration = selectedEntry?.generation;
  const isSelectedEntryCurrent = () =>
    isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
    params.runs.get(completeParams.runId) === selectedEntry &&
    selectedEntry?.generation === selectedGeneration &&
    completeParams.recoveryCurrent?.isHostCurrent() !== false;
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    if (!isSelectedEntryCurrent()) {
      throw new Error("Subagent terminal publication lost its original owner");
    }
  };
  const releaseCompletionLock = await context.acquireTerminalCompletionLock(completeParams.runId);
  let entry: SubagentRunRecord | undefined;
  let terminalGeneration = 0;
  let mutated = false;
  let completionReason = completeParams.reason;
  let sessionSuperseded = false;
  let suppressSessionEffects = completeParams.suppressSessionEffects === true;
  let provisionalKillSnapshot: SubagentRunRecord | undefined;
  let entrySnapshot: SubagentRunRecord | undefined;
  let collectorSession: SubagentKillSession | undefined;
  try {
    if (!isSelectedEntryCurrent()) {
      return;
    }
    assertCurrent();
    entry = params.runs.get(completeParams.runId);
    if (!entry) {
      return;
    }
    const currentEntry = entry;
    const ownerPauseReason = currentEntry.pauseReason;
    if (completeParams.expectedEntry && entry !== completeParams.expectedEntry) {
      return;
    }
    suppressSessionEffects ||= await context.shouldSuppressSessionEffects(
      entry,
      completeParams.sessionEffects,
    );
    if (
      (completeParams.recoveryCurrent && !(await completeParams.recoveryCurrent.prepare())) ||
      !isSelectedEntryCurrent() ||
      currentEntry.pauseReason !== ownerPauseReason
    ) {
      return;
    }
    assertCurrent();
    if (entry.collect && !entry.collectorCompletion) {
      collectorSession = await prepareSubagentKillSession(
        params.getRuntimeConfig(),
        entry.childSessionKey,
        assertCurrent,
        entry.execution.transcriptTarget,
      );
      if (
        (completeParams.recoveryCurrent && !(await completeParams.recoveryCurrent.prepare())) ||
        !isSelectedEntryCurrent() ||
        currentEntry.pauseReason !== ownerPauseReason
      ) {
        return;
      }
      assertCurrent();
    }
    context.bindTerminalSessionEffects(entry, completeParams.sessionEffects);
    params.clearPendingLifecycleError(completeParams.runId);
    entrySnapshot = captureSubagentRunMutationSnapshot(entry);
    const commit = async (previous: SubagentRunRecord, onPublished?: () => void) => {
      const result = await publishSubagentRunPostimages({
        runs: params.runs,
        previous: new Map([[currentEntry, previous]]),
        context: stateContext,
        persist: params.persistAsyncOrThrow,
        assertCurrent: () => {
          assertCurrent();
          collectorSession?.assertCurrent();
        },
        onPublished,
      });
      return result.publication === "published";
    };
    const restoreEntrySnapshot = (snapshot: SubagentRunRecord) => {
      for (const key of Object.keys(currentEntry)) {
        Reflect.deleteProperty(currentEntry, key);
      }
      Object.assign(currentEntry, snapshot);
    };
    const recoveryRequested = completeParams.recoverInterrupted === true;
    if (
      !recoveryRequested &&
      (entry.terminalOwner === "interrupted-recovery" ||
        entry.execution.suppressSessionEffects === true) &&
      entry.killIntent === undefined
    ) {
      // Restart recovery already persisted the terminal winner for this exact
      // run. Its sticky fence survives cleanup of the transient owner marker.
      return;
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
        (outcome.startedAt === undefined ||
          outcome.startedAt === currentEntry.execution.startedAt) &&
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
        return;
      }
      if (!ownsInterruptedRecovery) {
        const endedAt =
          typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
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
        mutated = true;
        if (!(await commit(entrySnapshot))) {
          return;
        }
        // Any later delivery-payload write rolls back to this durable owner,
        // never to the pre-recovery running row.
        entrySnapshot = captureSubagentRunMutationSnapshot(entry);
        mutated = false;
      }
    }
    sessionSuperseded = context.newerGenerationOwnsSession(currentEntry);
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
      return;
    }
    let requestedEndedAt =
      typeof completeParams.endedAt === "number" ? completeParams.endedAt : Date.now();
    if (shouldPreservePublishedExplicitRunTimeout(entry)) {
      return;
    }
    const shouldDrainExistingTerminal =
      recoveryRequested ||
      isOlderEquivalentTerminalCallback({
        entry,
        endedAt: requestedEndedAt,
        outcome: completeParams.outcome,
        reason: completeParams.reason,
      });
    if (shouldDrainExistingTerminal) {
      // Preserve the newer canonical timing while allowing this duplicate
      // caller to rescue a stalled cleanup and delivery tail.
      requestedEndedAt = entry.execution.endedAt!;
      completionReason = entry.endedReason ?? completeParams.reason;
    }
    let endedAt = requestedEndedAt;
    let completionOutcome =
      shouldDrainExistingTerminal && entry.execution.outcome
        ? entry.execution.outcome
        : completeParams.outcome;
    const liveStructuredOutput = entry.collect
      ? (entry.structuredOutput ??
        peekSwarmStructuredOutput(entry.runId) ??
        (entry.swarmRunId ? peekSwarmStructuredOutput(entry.swarmRunId) : undefined))
      : undefined;
    if (!entry.structuredOutput && liveStructuredOutput) {
      entry.structuredOutput = liveStructuredOutput;
      mutated = true;
    }
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
      mutated = true;
    }
    if (
      completionReason !== SUBAGENT_ENDED_REASON_KILLED &&
      entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.killReconciliation === undefined
    ) {
      // Only current-version provisional kills carry reconciliation state.
      // Legacy or already-stabilized killed rows are terminal cancellation.
      return;
    }
    const isSteerRestartKill =
      completeParams.reason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.suppressAnnounceReason === "steer-restart";
    if (completionReason === SUBAGENT_ENDED_REASON_KILLED && !isSteerRestartKill) {
      entry.suppressAnnounceReason = "killed";
      entry.killReconciliation ??= {
        killedAt: requestedEndedAt,
      };
      mutated = true;
    }

    if (
      completionReason !== SUBAGENT_ENDED_REASON_KILLED &&
      entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      entry.killReconciliation !== undefined
    ) {
      const killReconciliation = entry.killReconciliation;
      const stableTaskCancellation = entry.killReconciliation?.taskCancellationAccepted === true;
      const cancellationEndedAt = resolveKilledSubagentTaskEndedAt(entry);
      const completionPredatesCancellation =
        typeof cancellationEndedAt === "number" && endedAt < cancellationEndedAt;
      if (stableTaskCancellation && !completionPredatesCancellation) {
        // Native cancellation promotes the provisional marker to durable operator
        // intent. Only an already-durable earlier completion may reopen it.
        return;
      }
      provisionalKillSnapshot = captureSubagentRunMutationSnapshot(currentEntry);
      // The sweeper uses marker identity to reject a concurrently replaced
      // kill generation. A completion rollback must retain the same marker.
      provisionalKillSnapshot.killReconciliation = killReconciliation;
      // Completion capture yields. Stage the provider result off-registry so
      // an unrelated persistence write cannot publish a tentative winner.
      entry = structuredClone(currentEntry);
      entry.suppressCompletionDelivery =
        killReconciliation.suppressTaskDelivery === true ? true : undefined;
      entry.suppressAnnounceReason = undefined;
      entry.killReconciliation = undefined;
      entry.cleanupHandled = false;
      entry.cleanupCompletedAt = undefined;
      clearDeliveryState(entry);
      mutated = true;
    }

    if (observedStartedAt !== undefined && entry.execution.startedAt !== observedStartedAt) {
      entry.execution = { ...entry.execution, startedAt: observedStartedAt };
      if (typeof entry.sessionStartedAt !== "number") {
        entry.sessionStartedAt = observedStartedAt;
      }
      mutated = true;
    }

    if (
      completionReason === SUBAGENT_ENDED_REASON_COMPLETE &&
      completionOutcome.status !== "error" &&
      provisionalKillSnapshot !== undefined
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
        mutated = true;
      }
    }
    const terminalReply = mergeAgentRunTerminalReplySnapshot(
      entry.completion?.terminalReply,
      completeParams.terminalReply,
    );
    // Lifecycle events and agent.wait both settle here. A required success
    // needs producer evidence before any transcript fallback can freeze it.
    if (
      entry.expectsCompletionMessage === true &&
      completionOutcome.status === "ok" &&
      !terminalReply
    ) {
      // An unproven success cannot replace the cancellation already owned by this run.
      if (provisionalKillSnapshot) {
        return;
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
      mutated = true;
    }
    if (entry.endedReason !== completionReason) {
      entry.endedReason = completionReason;
      mutated = true;
    }
    if (completionReason === SUBAGENT_ENDED_REASON_KILLED && entry.terminalOwner !== undefined) {
      entry.terminalOwner = undefined;
      mutated = true;
    }
    if (entry.pauseReason !== undefined) {
      entry.pauseReason = undefined;
      mutated = true;
    }

    if (completeParams.completionSnapshot) {
      const completion = ensureCompletionState(entry);
      if (
        completion.resultText !== completeParams.completionSnapshot.resultText ||
        completion.capturedAt !== completeParams.completionSnapshot.capturedAt
      ) {
        completion.resultText = completeParams.completionSnapshot.resultText;
        completion.capturedAt = completeParams.completionSnapshot.capturedAt;
        mutated = true;
      }
    }

    if (terminalReply) {
      const completion = ensureCompletionState(entry);
      if (JSON.stringify(terminalReply) !== JSON.stringify(completion.terminalReply)) {
        completion.terminalReply = terminalReply;
        completion.resultText =
          terminalReply.disposition === "visible"
            ? terminalReply.text
            : terminalReply.disposition === "silent"
              ? SILENT_REPLY_TOKEN
              : null;
        completion.capturedAt = endedAt;
        mutated = true;
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
      mutated = true;
    }

    // A newer generation may share the session key. Its transcript/reply is
    // not evidence for this older run, so reconcile only the terminal task state.
    if (recoveryRequested || sessionSuperseded) {
      const completion = ensureCompletionState(entry);
      if (completion.resultText === undefined) {
        completion.resultText = null;
        completion.capturedAt = Date.now();
        mutated = true;
      }
    } else {
      const executionBeforeCapture = currentEntry.execution;
      const didFreezeResult = await freezeRunResultAtCompletion(
        context,
        entry,
        executionOutcome,
        assertCurrent,
      );
      // Native persistence is now the sole terminal commit. Capture must not give
      // an old callback authority over a replacement row or a newer cancellation.
      if (
        (completeParams.recoveryCurrent && !(await completeParams.recoveryCurrent.prepare())) ||
        !isSelectedEntryCurrent() ||
        currentEntry.execution !== executionBeforeCapture ||
        currentEntry.pauseReason === "sessions_yield"
      ) {
        return;
      }
      assertCurrent();
      sessionSuperseded = context.newerGenerationOwnsSession(entry);
      if (sessionSuperseded) {
        const completion = ensureCompletionState(entry);
        completion.resultText = null;
        completion.capturedAt = Date.now();
        mutated = true;
      } else if (didFreezeResult) {
        mutated = true;
      }
    }
    if (
      entry.collect
        ? updateSwarmCollectorCompletion(entry, params.getRuntimeConfig(), {
            entry: collectorSession?.entry,
          })
        : updateSubagentArchiveAtMs(entry, params.getRuntimeConfig())
    ) {
      mutated = true;
    }
    if (provisionalKillSnapshot) {
      // Capture may race cancellation on this exact physical execution.
      // Recheck the live marker before replacing the staged native outcome.
      const stableTaskCancellation =
        currentEntry.killReconciliation?.taskCancellationAccepted === true;
      const cancellationEndedAt = resolveKilledSubagentTaskEndedAt(provisionalKillSnapshot);
      const completionPredatesCancellation =
        typeof cancellationEndedAt === "number" && endedAt < cancellationEndedAt;
      if (stableTaskCancellation && !completionPredatesCancellation) {
        // Cancellation can become durable while completion capture yields.
        // The provider transition is staged, so the live tombstone is intact.
        return;
      }
    }
    if (refreshPendingFinalDeliveryPayload(entry)) {
      mutated = true;
    }

    // Native cancellation and completion share this exact run generation.
    if (provisionalKillSnapshot) {
      entry.browserCleanupDispatchedAt ??= currentEntry.browserCleanupDispatchedAt;
      if (currentEntry.killReconciliation?.suppressTaskDelivery === true) {
        entry.suppressCompletionDelivery = true;
      }
      const liveBeforeCommit = captureSubagentRunMutationSnapshot(currentEntry);
      restoreEntrySnapshot(entry);
      entry = currentEntry;
      if (!(await commit(liveBeforeCommit, () => context.bumpCleanupGeneration(currentEntry)))) {
        return;
      }
      // A provider result supersedes provisional cleanup only after its native
      // terminal commit. Rejected callbacks leave the kill tail live.
    } else if (mutated && !(await commit(entrySnapshot))) {
      return;
    }
    terminalGeneration = context.bumpTerminalGeneration(entry);
  } finally {
    // Only the canonical state/capture transition is serialized. Cleanup
    // remains re-entrant so a stalled browser close cannot strand a duplicate callback.
    releaseCompletionLock();
    await collectorSession?.release();
  }

  if (!entry) {
    return;
  }
  await completeTerminalEffects(context, {
    completeParams,
    completionReason,
    entry,
    mutated,
    sessionSuperseded,
    suppressSessionEffects,
    terminalGeneration,
    stateContext,
    assertCurrent,
    loadCleanupBrowserSessionsForLifecycleEnd:
      params.loadCleanupBrowserSessionsForLifecycleEnd ?? loadCleanupBrowserSessionsForLifecycleEnd,
  });
}
