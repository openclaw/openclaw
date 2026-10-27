import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { projectChatErrorDetail } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { recordSessionCompacted } from "../sessions/session-state-events.js";
import { extractErrorHttpStatus } from "../shared/assistant-error-format.js";
import {
  hasAcceptedSessionSpawn,
  hasCompletionMessageSessionSpawn,
} from "./accepted-session-spawn.js";
import { stripStaleAssistantUsageBeforeLatestCompaction } from "./compaction-usage.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
} from "./embedded-agent-error-observation.js";
import { classifyAssistantFailoverReason } from "./embedded-agent-helpers/assistant-message-failures.js";
import {
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
} from "./embedded-agent-helpers/error-text.js";
import { classifyCompactionReason } from "./embedded-agent-runner/compact-reasons.js";
import { hasCommittedMessagingToolDeliveryEvidence } from "./embedded-agent-runner/delivery-evidence.js";
import {
  hasAttemptTerminalState,
  hasAsyncActivity,
} from "./embedded-agent-runner/run/attempt-terminal-evidence.js";
import { resolveFinalAssistantVisibleText } from "./embedded-agent-runner/run/helpers.js";
import { isIncompleteTerminalAssistantTurn } from "./embedded-agent-runner/run/incomplete-turn-classification.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  hasAssistantVisibleReply,
  readPendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { finalizeToolActivity } from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { isAssistantMessage } from "./embedded-agent-utils.js";
import type { AgentSessionEvent } from "./sessions/index.js";
import { summarizeToolValidationError } from "./tool-error-summary.js";

type SessionCompactionStartEvent = Extract<AgentSessionEvent, { type: "compaction_start" }>;
type SessionCompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;

type CompactionStartEvent = Omit<SessionCompactionStartEvent, "reason"> & { reason?: unknown };

function emitCompactionAgentEvent(
  ctx: EmbeddedAgentSubscribeContext,
  data:
    | { phase: "start"; itemId?: string }
    | {
        phase: "end";
        itemId?: string;
        completed: boolean;
        willRetry: boolean;
        outcome: SessionCompactionEndEvent["outcome"]["status"];
        reason?: string;
        qualityDegraded?: true;
      },
): void {
  const event = { stream: "compaction" as const, data };
  emitAgentEvent({ runId: ctx.params.runId, ...event });
  runBestEffortCallback({
    label: "compaction agent event",
    log: ctx.log,
    callback: () => ctx.params.onAgentEvent?.(event),
  });
}

function runBestEffortCompactionHook(
  ctx: EmbeddedAgentSubscribeContext,
  phase: "before" | "after",
): void {
  // Queued events still settle committed facts and waiters after close, not new plugin work.
  if (ctx.state.unsubscribed || ctx.params.isTerminalAborted?.()) {
    return;
  }
  const hookRunner = getGlobalHookRunner();
  const hookName = phase === "before" ? "before_compaction" : "after_compaction";
  if (!hookRunner?.hasHooks(hookName)) {
    return;
  }
  const metrics = {
    messageCount: ctx.params.session.messages?.length ?? 0,
    sessionFile: ctx.params.session.sessionFile,
  };
  const context = { sessionKey: ctx.params.sessionKey };
  const hook =
    phase === "before"
      ? hookRunner.runBeforeCompaction(
          { ...metrics, messages: ctx.params.session.messages },
          context,
        )
      : hookRunner.runAfterCompaction(
          { ...metrics, compactedCount: ctx.getCompactionCount() },
          context,
        );
  void hook.catch((err: unknown) => {
    ctx.log.warn(`${hookName} hook failed: ${String(err)}`);
  });
}

export function handleCompactionStart(
  ctx: EmbeddedAgentSubscribeContext,
  evt: CompactionStartEvent,
) {
  // Unknown reasons come from external runtimes or older sessions. Treat them as
  // threshold compaction so logs and event payloads stay on the closed reason set.
  const rawReason = evt.reason;
  const reason =
    rawReason === "manual" || rawReason === "threshold" || rawReason === "overflow"
      ? rawReason
      : "threshold";
  const kind = reason === "manual" ? "manual compaction" : "auto-compaction";
  ctx.state.compactionInFlight = true;
  ctx.state.livenessState = "paused";
  ctx.ensureCompactionPromise();
  ctx.log.info(`embedded run ${kind} start`, {
    event: "embedded_run_compaction_start",
    runId: ctx.params.runId,
    reason,
    consoleMessage: `embedded run ${kind} start: runId=${ctx.params.runId} reason=${reason}`,
  });
  emitCompactionAgentEvent(ctx, { phase: "start", ...(evt.itemId ? { itemId: evt.itemId } : {}) });

  // Hooks are fire-and-forget so compaction state updates and liveness pauses
  // cannot be delayed by plugin work.
  if (!evt.hooksHandled) {
    runBestEffortCompactionHook(ctx, "before");
  }
}

export function handleCompactionEnd(
  ctx: EmbeddedAgentSubscribeContext,
  evt: SessionCompactionEndEvent,
) {
  const reason = evt.reason;
  const kind = reason === "manual" ? "manual compaction" : "auto-compaction";
  const outcome = evt.outcome;
  ctx.state.compactionInFlight = false;
  const completed = outcome.status === "completed";
  const willRetry = completed && outcome.willRetry;
  let recording: Promise<void> | undefined;
  if (completed) {
    ctx.incrementCompactionCount();
    ctx.noteCompactionTokensAfter(outcome.tokensAfter);
    const observedCompactionCount = ctx.getCompactionCount();
    if (ctx.params.sessionPersistence !== "detached") {
      recording = recordSessionCompacted({
        sessionKey: ctx.params.sessionKey,
        operationId: `${ctx.params.runId}:${observedCompactionCount}`,
        agentId: ctx.params.agentId,
        runId: ctx.params.runId,
      });
    }
    ctx.log.info(`embedded run ${kind} complete`, {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      completed: true,
      willRetry,
      compactionCount: observedCompactionCount,
      consoleMessage: `embedded run ${kind} complete: runId=${ctx.params.runId} reason=${reason} compactionCount=${observedCompactionCount} willRetry=${willRetry}`,
    });
    // Caller-owned turns persist once after settlement; detached runs never write metadata.
    // Keep the legacy floor for direct durable subscriptions without that handoff.
    if (
      ctx.params.compactionCountOwner !== "caller" &&
      ctx.params.sessionPersistence !== "detached"
    ) {
      void import("./embedded-agent-subscribe.handlers.compaction.runtime.js")
        .then(({ default: reconcile }) =>
          reconcile({
            sessionKey: ctx.params.sessionKey,
            agentId: ctx.params.agentId,
            configStore: ctx.params.config?.session?.store,
            observedCompactionCount,
          }),
        )
        .catch((err: unknown) => {
          ctx.log.warn(`late compaction count reconcile failed: ${String(err)}`);
        });
    }
  }
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
  } else {
    if (outcome.status !== "aborted") {
      ctx.state.livenessState = "working";
    }
    ctx.maybeResolveCompactionWait();
    const messages = ctx.params.session.messages;
    // Only a compaction that actually rewrote history invalidates prior usage.
    // A failed/aborted/skipped end must keep live assistant usage intact —
    // zeroing it disables the persistent-error compaction trigger exactly in
    // the degraded sessions that need it.
    if (completed) {
      // Marker-free final compaction has no fresh boundary, so stale totals
      // must be cleared before later context counters inspect assistant usage.
      stripStaleAssistantUsageBeforeLatestCompaction(messages, {
        mutate: true,
        whenMissingCompactionSummary: "zeroAssistantUsage",
      });
    }
  }
  const outcomeReason =
    outcome.status === "skipped" || outcome.status === "failed" ? outcome.reason : undefined;
  if (!completed) {
    const reasonClass = outcomeReason ? classifyCompactionReason(outcomeReason) : "aborted";
    const metadata = {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      outcome: outcome.status,
      completed: false,
      willRetry: false,
      reasonClass,
      consoleMessage: `embedded run ${kind} ${outcome.status}: runId=${ctx.params.runId} reason=${reasonClass}`,
    };
    const benign =
      outcome.status === "aborted" ||
      (outcome.status === "skipped" &&
        (reasonClass === "no_compactable_entries" ||
          reasonClass === "below_threshold" ||
          reasonClass === "already_compacted"));
    ctx.log[benign ? "info" : "warn"](`embedded run ${kind} ${outcome.status}`, metadata);
  }
  emitCompactionAgentEvent(ctx, {
    phase: "end",
    ...(evt.itemId ? { itemId: evt.itemId } : {}),
    completed,
    willRetry,
    outcome: outcome.status,
    ...(completed && outcome.qualityDegraded ? { qualityDegraded: true } : {}),
    ...(outcomeReason ? { reason: outcomeReason } : {}),
  });

  // after_compaction runs only once the run will not retry, matching the visible
  // post-compaction session state plugin authors observe.
  if (completed && !willRetry && !evt.hooksHandled) {
    runBestEffortCompactionHook(ctx, "after");
  }
  return recording;
}

function runTerminalHook<T>(callback: () => T | Promise<T>, failed: (error: unknown) => void) {
  let result: T | Promise<T>;
  try {
    result = callback();
  } catch (error) {
    failed(error);
    return undefined;
  }
  return isPromiseLike<T>(result)
    ? Promise.resolve(result).catch((error: unknown) => {
        failed(error);
      })
    : result;
}

function emitLifecycleAgentEvent(
  ctx: EmbeddedAgentSubscribeContext,
  data: Record<string, unknown>,
  eventData = data,
) {
  emitAgentEvent({
    runId: ctx.params.runId,
    ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
    ...(ctx.params.sessionId ? { sessionId: ctx.params.sessionId } : {}),
    ...(ctx.params.agentId ? { agentId: ctx.params.agentId } : {}),
    ...(ctx.params.lifecycleGeneration
      ? { lifecycleGeneration: ctx.params.lifecycleGeneration }
      : {}),
    stream: "lifecycle",
    data: eventData,
  });
  runBestEffortCallback({
    label: "lifecycle agent event",
    log: ctx.log,
    callback: () =>
      ctx.params.onAgentEvent?.({
        stream: "lifecycle",
        data,
      }),
  });
}

export function handleAgentStart(ctx: EmbeddedAgentSubscribeContext) {
  // A same-prompt follow-up starts another core loop under the same delivery policy.
  ctx.state.deferBlockReplyDelivery =
    typeof ctx.params.onBeforeTerminalDelivery === "function" &&
    ctx.params.deferTerminalDelivery !== false;
  emitLifecycleAgentEvent(ctx, { phase: "start", startedAt: Date.now() });
}

export function handleAgentEnd(
  ctx: EmbeddedAgentSubscribeContext,
  evt?: Extract<AgentSessionEvent, { type: "agent_end" }>,
): void | Promise<void> {
  ctx.state.liveEditDiffStateById.clear();
  type BeforeTerminalDeliveryDecision = void | {
    suppressTerminalDelivery?: boolean;
    continueCurrentTurn?: boolean;
  };
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  let lifecycleErrorText: string | undefined;
  let errorObservation: ReturnType<typeof projectChatErrorDetail>;
  // Terminal delivery does not depend on streamed text alone: when the streamed
  // assistant texts are empty, payload building falls back to the completed
  // assistant message's visible text, so such a turn still reaches the user.
  // Classification must key on the same fact, otherwise a delivered reply is
  // recorded here as an abandoned, replay-invalid turn. Error and abort stop
  // reasons keep the streamed-only view because their raw text can describe an
  // interrupted generation rather than a reply (mirrors attempt finalization).
  const hasStreamedAssistantVisibleText = ctx.state.assistantTexts.some((text) =>
    hasAssistantVisibleReply({ text }),
  );
  const completedAssistantFallbackText =
    isAssistantMessage(lastAssistant) &&
    lastAssistant.stopReason !== "error" &&
    lastAssistant.stopReason !== "aborted"
      ? resolveFinalAssistantVisibleText(lastAssistant)
      : undefined;
  const hasAssistantVisibleText =
    hasStreamedAssistantVisibleText ||
    hasAssistantVisibleReply({ text: completedAssistantFallbackText ?? "" });
  const hadLivenessPreservingSideEffect =
    ctx.state.hadDeterministicSideEffect === true ||
    hasCommittedMessagingToolDeliveryEvidence(ctx.state) ||
    hasAcceptedSessionSpawn(ctx.state.acceptedSessionSpawns) ||
    (ctx.state.successfulCronAdds ?? 0) > 0;
  const deferredMediaUrls = ctx.state.deferredBlockReplies.flatMap(
    (payload) => payload.mediaUrls ?? [],
  );
  const hasTerminalOutput = hasAttemptTerminalState({
    yieldDetected: ctx.state.yielded,
    didSendDeterministicApprovalPrompt: ctx.state.deterministicApprovalPromptSent,
    toolMediaUrls: [...ctx.state.pendingToolMediaUrls, ...deferredMediaUrls],
    toolAudioAsVoice:
      ctx.state.pendingToolAudioAsVoice ||
      ctx.state.deferredBlockReplies.some((payload) => payload.audioAsVoice),
    hasToolMediaBlockReply: ctx.state.hasToolMediaBlockReply,
    didDeliverSourceReplyViaMessageTool:
      ctx.state.messageToolOnlySourceReplyDelivered ||
      ctx.params.hasDeliveredMessageToolOnlySourceReply?.() === true,
    messagingToolSourceReplyPayloads: ctx.state.messagingToolSourceReplyPayloads,
    messagingToolSentTexts: ctx.state.messagingToolSentTexts,
    messagingToolSentMediaUrls: ctx.state.messagingToolSentMediaUrls,
    messagingToolSentTargets: ctx.state.messagingToolSentTargets,
    successfulCronAdds: ctx.state.successfulCronAdds,
    acceptedSessionSpawns: ctx.state.acceptedSessionSpawns,
    toolMetas: ctx.state.toolMetas,
  });
  const hadBeforeFinalizeSideEffect =
    hadLivenessPreservingSideEffect || ctx.state.replayState.hadPotentialSideEffects;
  const incompleteTerminalAssistant = isIncompleteTerminalAssistantTurn({
    hasAssistantVisibleText,
    hasTerminalOutput,
    lastAssistant: isAssistantMessage(lastAssistant) ? lastAssistant : null,
  });
  const replayInvalid =
    ctx.state.replayState.replayInvalid || incompleteTerminalAssistant ? true : undefined;
  // Tool-use terminal guard: when the last assistant message ended with a
  // tool-call stop reason, the turn is incomplete even when pre-tool text
  // exists — mark as abandoned so lifecycle consumers do not see a working
  // end state for an interrupted tool chain. (#76477)
  const derivedWorkingTerminalState = isError
    ? "blocked"
    : replayInvalid &&
        !hadLivenessPreservingSideEffect &&
        (!hasAssistantVisibleText || incompleteTerminalAssistant)
      ? "abandoned"
      : ctx.state.livenessState;
  const livenessState =
    ctx.state.livenessState === "working" ? derivedWorkingTerminalState : ctx.state.livenessState;

  if (isError && lastAssistant) {
    const rawError = lastAssistant.errorMessage?.trim();
    const failoverReason = classifyAssistantFailoverReason(lastAssistant, {
      providerOwner: ctx.params.providerOwner ?? null,
    });
    const errorText = formatUserFacingAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      agentId: ctx.params.agentId,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
      providerOwner: ctx.params.providerOwner,
    });
    const observedError = buildApiErrorObservationFields(rawError, {
      provider: lastAssistant.provider,
      providerOwner: ctx.params.providerOwner,
      code: lastAssistant.errorCode,
    });
    const safeErrorText =
      buildTextObservationFields(errorText, {
        provider: lastAssistant.provider,
      }).textPreview ?? GENERIC_ASSISTANT_ERROR_TEXT;
    lifecycleErrorText = safeErrorText;
    // Lifecycle events also reach clients, so log-only diagnostics must not leave here.
    errorObservation = projectChatErrorDetail({
      provider: lastAssistant.provider,
      model: lastAssistant.model,
      failoverReason,
      ...observedError,
      httpStatus: extractErrorHttpStatus(rawError ?? "")?.code,
    });
    const safeRunId = sanitizeForConsole(ctx.params.runId) ?? "-";
    const safeModel = sanitizeForConsole(lastAssistant.model) ?? "unknown";
    const safeProvider = sanitizeForConsole(lastAssistant.provider) ?? "unknown";
    ctx.log.warn("embedded run agent end", {
      event: "embedded_run_agent_end",
      tags: ["error_handling", "lifecycle", "agent_end", "assistant_error"],
      runId: ctx.params.runId,
      isError: true,
      failoverReason,
      model: lastAssistant.model,
      provider: lastAssistant.provider,
      rawErrorHash: observedError.rawErrorHash,
      rawErrorFingerprint: observedError.rawErrorFingerprint,
      httpCode: observedError.httpCode,
      providerRuntimeFailureKind: observedError.providerRuntimeFailureKind,
      providerErrorType: observedError.providerErrorType,
      requestIdHash: observedError.requestIdHash,
      consoleMessage: `embedded run agent end: runId=${safeRunId} isError=true model=${safeModel} provider=${safeProvider} failoverReason=${failoverReason ?? "unknown"}`,
    });
  }

  const emitLifecycleTerminal = () => {
    finalizeToolActivity(ctx);
    const terminalStopReason =
      ctx.params.resolveTerminalStopReason?.() ??
      ctx.state.terminalStopReason ??
      (!isError && isAssistantMessage(lastAssistant) ? lastAssistant.stopReason : undefined);
    const terminalAborted = ctx.state.terminalAborted ?? ctx.params.isTerminalAborted?.();
    // Aborted validation loops lose their final tool result. Preserve only the
    // argument-free validator summary; arbitrary tool errors can contain secrets.
    const toolErrorSummary =
      terminalAborted === true && ctx.state.lastToolError
        ? summarizeToolValidationError(ctx.state.lastToolError)
        : undefined;
    const data = {
      phase:
        ctx.params.terminalLifecyclePhase === "finishing" ? "finishing" : isError ? "error" : "end",
      ...(isError ? { error: lifecycleErrorText ?? GENERIC_ASSISTANT_ERROR_TEXT } : {}),
      ...(errorObservation ? { errorObservation } : {}),
      ...(terminalStopReason ? { stopReason: terminalStopReason } : {}),
      ...(ctx.state.yielded === true ? { yielded: true } : {}),
      ...(ctx.state.timeoutPhase ? { timeoutPhase: ctx.state.timeoutPhase } : {}),
      ...(ctx.state.providerStarted !== undefined
        ? { providerStarted: ctx.state.providerStarted }
        : {}),
      ...(terminalAborted !== undefined ? { aborted: terminalAborted } : {}),
      ...(toolErrorSummary ? { toolErrorSummary } : {}),
      ...(livenessState ? { livenessState } : {}),
      ...(replayInvalid ? { replayInvalid } : {}),
    };
    emitLifecycleAgentEvent(ctx, data, { ...data, endedAt: Date.now() });
  };

  const finalizeAgentEnd = () => {
    if (ctx.state.pendingCompactionRetry > 0) {
      ctx.resolveCompactionRetry();
    } else {
      ctx.maybeResolveCompactionWait();
    }
  };

  const flushPendingMediaAndChannel = () => {
    if (ctx.params.onBlockReply && !ctx.state.pendingToolMediaDeliveryFailed) {
      const pendingToolMediaReply = readPendingToolMediaReply(ctx.state);
      if (pendingToolMediaReply && hasAssistantVisibleReply(pendingToolMediaReply)) {
        ctx.emitBlockReply(pendingToolMediaReply);
      }
    }

    const flushChannel = () => {
      const result = ctx.params.onBlockReplyFlush?.({ reason: "terminal" });
      return isPromiseLike<void>(result) ? result : undefined;
    };
    const postMediaFlushResult = ctx.flushBlockReplyBuffer();
    return isPromiseLike<void>(postMediaFlushResult)
      ? postMediaFlushResult.then(flushChannel)
      : flushChannel();
  };

  const rethrowAfterLifecycleTerminal = (error: unknown) => {
    const emitted = emitLifecycleTerminalOnce();
    if (isPromiseLike<void>(emitted)) {
      return Promise.resolve(emitted).then(() => {
        throw error;
      });
    }
    throw error;
  };

  let lifecycleTerminalEmitted = false;
  const emitLifecycleTerminalOnce = (): void | Promise<void> => {
    if (lifecycleTerminalEmitted) {
      return;
    }
    lifecycleTerminalEmitted = true;
    const beforeLifecycleTerminal = runTerminalHook(
      () => ctx.params.onBeforeLifecycleTerminal?.(),
      (err) => ctx.log.debug(`before lifecycle terminal failed: ${String(err)}`),
    );
    if (isPromiseLike<void>(beforeLifecycleTerminal)) {
      return Promise.resolve(beforeLifecycleTerminal).then(emitLifecycleTerminal);
    }
    emitLifecycleTerminal();
  };

  const applyBeforeTerminalDecision = (decision: BeforeTerminalDeliveryDecision) => {
    if (decision?.suppressTerminalDelivery === true) {
      ctx.clearAssistantStream();
      ctx.clearDeferredBlockReplies();
      finalizeAgentEnd();
      return undefined;
    }
    if (decision?.continueCurrentTurn === true) {
      // Publish this checkpoint normally, but keep the run and its delivery owner
      // alive until the already-queued same-prompt follow-up settles.
      ctx.releaseDeferredReplies();
      finalizeAgentEnd();
      return ctx.flushBlockReplyBuffer();
    }
    try {
      ctx.releaseDeferredReplies();
      const flushBlockReplyBufferResult = ctx.flushBlockReplyBuffer({ final: true });
      finalizeAgentEnd();
      const flushPendingMediaAndChannelResult = isPromiseLike<void>(flushBlockReplyBufferResult)
        ? Promise.resolve(flushBlockReplyBufferResult).then(flushPendingMediaAndChannel)
        : flushPendingMediaAndChannel();

      if (isPromiseLike<void>(flushPendingMediaAndChannelResult)) {
        return Promise.resolve(flushPendingMediaAndChannelResult).then(
          emitLifecycleTerminalOnce,
          rethrowAfterLifecycleTerminal,
        );
      }
      return emitLifecycleTerminalOnce();
    } catch (error) {
      return rethrowAfterLifecycleTerminal(error);
    }
  };

  const beforeTerminalDelivery = runTerminalHook(
    () => {
      // The acceptance hook inspects the answer this turn delivers, including a kept answer.
      const answerAssistant = ctx.state.keptAnswer?.assistant ?? lastAssistant;
      return ctx.params.onBeforeTerminalDelivery?.({
        messages: evt?.messages ?? [],
        willRetry: evt?.willRetry === true,
        ...(evt?.assistantEntryId ? { assistantEntryId: evt.assistantEntryId } : {}),
        ...(answerAssistant ? { lastAssistant: answerAssistant } : {}),
        assistantTexts: ctx.state.assistantTexts,
        hasAssistantVisibleText,
        isError,
        incompleteTerminalAssistant,
        hadDeterministicSideEffect: hadBeforeFinalizeSideEffect,
        hasPendingContinuation:
          ctx.state.yielded ||
          ctx.state.deterministicApprovalPromptPending ||
          ctx.state.deterministicApprovalPromptSent ||
          hasCompletionMessageSessionSpawn(ctx.state.acceptedSessionSpawns) ||
          hasAsyncActivity(ctx.state.toolMetas),
      });
    },
    (error) => ctx.log.warn(`before terminal delivery failed: ${String(error)}`),
  );

  if (isPromiseLike<BeforeTerminalDeliveryDecision>(beforeTerminalDelivery)) {
    return Promise.resolve(beforeTerminalDelivery).then(applyBeforeTerminalDecision);
  }
  return applyBeforeTerminalDecision(beforeTerminalDelivery);
}
