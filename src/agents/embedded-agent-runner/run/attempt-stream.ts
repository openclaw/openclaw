import type { FirstStreamEventInternalOptions } from "@openclaw/ai/internal/runtime";
import type { CompactionReplayRejection } from "@openclaw/ai/transports";
import { resolveDiagnosticModelContentCapturePolicy } from "../../../infra/diagnostic-llm-content.js";
import { DEFAULT_UNDICI_STREAM_TIMEOUT_MS } from "../../../infra/net/undici-global-dispatcher.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { DiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { resolveToolCallArgumentsEncoding } from "../../../plugins/provider-model-compat.js";
import { captureAsyncWorkTracker } from "../../../shared/async-work-scope.js";
import {
  assertOperatorModelAllowed,
  readRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { shouldAllowProviderOwnedThinkingReplay } from "../../embedded-agent-helpers/turns.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import type { StreamFn } from "../../runtime/index.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { UNKNOWN_TOOL_THRESHOLD } from "../../tool-loop-detection.js";
import { wrapStreamFnCodeModeSource } from "../../transcript-code-mode-source.js";
import type { NormalizedUsage } from "../../usage.js";
import { log } from "../logger.js";
import { createPromptCacheRequestObserver } from "../prompt-cache-request-observer.js";
import { getProviderPromptState } from "../provider-prompt-state.js";
import {
  repairRejectedCompactionReplayInSessionManager,
  repairRejectedThinkingReplayInSessionManager,
} from "../thinking-replay-repair.js";
import {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  wrapAnthropicStreamWithRecovery,
} from "../thinking.js";
import { createHtmlEntityToolCallArgumentDecodingWrapper } from "../tool-call-argument-decoding.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import {
  createYieldAbortedResponse,
  isSessionsYieldAbortReason,
} from "./attempt-sessions-yield.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt-stop-reason-recovery.js";
import {
  sanitizeOpenAIResponsesReplayForStream,
  sanitizeReplayToolCallIdsForStream,
  shouldApplyReplayToolCallIdSanitizer,
  wrapStreamFnSanitizeMalformedToolCalls,
} from "./attempt-tool-call-replay-sanitization.js";
import { wrapStreamFnTrimToolCallNames } from "./attempt-tool-call-stream-normalization.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
import {
  resolveLlmFirstEventTimeoutMs,
  resolveLlmIdleTimeoutMs,
  streamWithIdleTimeout,
} from "./llm-idle-timeout.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";
import { wrapStreamObjectSettlement } from "./stream-wrapper.js";

type CompactionReplayStreamOptions = NonNullable<Parameters<StreamFn>[2]> & {
  onCompactionRejected?: (checkpoint: CompactionReplayRejection) => void;
};

function wrapStreamFnWithCompactionReplayRepair(
  streamFn: StreamFn,
  onRejected: (checkpoint: CompactionReplayRejection) => Promise<void>,
): StreamFn {
  return async (model, context, options) => {
    const trackRepair = captureAsyncWorkTracker();
    const repairs: Promise<void>[] = [];
    const joinRepairs = async () => {
      let joined = 0;
      while (joined !== repairs.length) {
        joined = repairs.length;
        const settled = await Promise.allSettled(repairs);
        const rejected = settled.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") {
          throw rejected.reason;
        }
      }
    };
    const replayOptions = options as CompactionReplayStreamOptions | undefined;
    const nextOptions: CompactionReplayStreamOptions = {
      ...options,
      onCompactionRejected: (checkpoint) => {
        const repair = trackRepair(() => onRejected(checkpoint));
        repairs.push(repair);
        void repair.catch(() => {});
        replayOptions?.onCompactionRejected?.(checkpoint);
      },
    };
    let response: Awaited<ReturnType<StreamFn>>;
    try {
      response = await streamFn(model, context, nextOptions);
    } catch (error) {
      await joinRepairs();
      throw error;
    }
    return wrapStreamObjectSettlement(response, joinRepairs);
  };
}

export function installEmbeddedAttemptStreamGuards(
  input: EmbeddedAttemptExecutionPhaseInput,
  callbacks: {
    onRejectedProviderReplayRepaired: () => void;
    onIdleTimeout: (error: Error) => void;
    diagnosticOwner: DiagnosticEmbeddedRunOwner;
  },
) {
  const { attempt } = input;
  const {
    agentSession: { activeSession: session, codeModeExecToolNames },
    anthropicPayloadLogger,
    cacheTrace,
    contextGuards,
    isOpenAIResponsesApi,
    sessionManager,
    state: { systemPromptText },
    transcriptPolicy,
    transport: {
      compactionReplayEnabled,
      effectiveAgentTransport,
      effectivePromptCacheRetention,
      streamStrategy,
      providerTextTransforms,
    },
  } = input.prepared.sessionRuntime;
  const { liveAllowedToolNames, replayAllowedToolNames } =
    input.prepared.toolCatalog.toolSearchRunPlan;
  const installStreamWrapper = <Args extends unknown[]>(
    wrapper: (stream: StreamFn, ...args: Args) => StreamFn,
    ...args: Args
  ) => {
    session.agent.streamFn = wrapper(session.agent.streamFn, ...args);
  };
  const { sessionAgentId } = input.setup;
  const { signal: abortSignal } = input.runAbortController;
  const operatorAuthority = readRunOperatorAuthority(attempt);
  if (operatorAuthority) {
    const providerStream = session.agent.streamFn;
    session.agent.streamFn = (model, context, options) => {
      assertOperatorModelAllowed(operatorAuthority, {
        provider: attempt.provider,
        model: attempt.modelId,
      });
      return providerStream(model, context, options);
    };
  }
  const repairRejectedReplay = async (
    kind: "compaction" | "thinking",
    checkpoint?: CompactionReplayRejection,
  ): Promise<void> => {
    try {
      const repairParams = {
        sessionManager,
        sessionFile: attempt.sessionFile,
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        agentId: sessionAgentId,
      };
      await withSessionManagerWrite(sessionManager, async () => {
        abortSignal.throwIfAborted();
        let repair;
        if (kind === "compaction") {
          if (!checkpoint) {
            log.warn(
              `[session-recovery] unable to repair rejected compaction replay: ` +
                `checkpoint identity unavailable sessionId=${session.sessionId}`,
            );
            return;
          }
          repair = await repairRejectedCompactionReplayInSessionManager({
            ...repairParams,
            checkpoint,
          });
        } else {
          repair = await repairRejectedThinkingReplayInSessionManager(repairParams);
        }
        if (repair.repaired) {
          callbacks.onRejectedProviderReplayRepaired();
          return;
        }
        log.warn(
          `[session-recovery] provider rejected ${kind} replay but transcript repair made no changes: ` +
            `sessionId=${session.sessionId} reason=${repair.reason ?? "unknown"}`,
        );
      });
    } catch (error) {
      log.warn(
        `[session-recovery] unable to repair rejected ${kind} replay: ` +
          `sessionId=${session.sessionId} error=${String(error)}`,
      );
    }
  };
  const providerPromptState = getProviderPromptState(attempt.runId);
  const cacheObserver = createPromptCacheRequestObserver(
    {
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      promptCacheKey: attempt.promptCacheKey,
      cacheRetention: effectivePromptCacheRetention,
      streamStrategy,
      transport: effectiveAgentTransport,
    },
    (observation, snapshot) => {
      if (observation.broke) {
        const changes =
          observation.changes?.map((change) => `${change.code}(${change.detail})`).join(", ") ??
          observation.dropCause;
        log.warn(
          `[prompt-cache] cache read dropped ${observation.previousCacheRead} -> ${observation.cacheRead} ` +
            `runId=${attempt.runId} request=${observation.requestIndex} for ${snapshot.provider}/${snapshot.modelId} via ${streamStrategy}; ${changes}; ` +
            `requestGapMs=${observation.requestGapMs ?? "unknown"} promptTokens=${observation.promptTokens ?? "unknown"} ` +
            `providerPrefix=${observation.providerPrefix ?? "unavailable"}`,
        );
      }
      cacheTrace?.recordStage("cache:result", { options: { ...observation } });
    },
    (request) => {
      cacheTrace?.recordStage("cache:state", {
        options: { ...request, previousCacheRead: request.previousCacheRead ?? undefined },
      });
    },
  );
  if (cacheTrace) {
    cacheTrace.recordStage("session:loaded", {
      messages: session.messages,
      system: systemPromptText,
      note: "after session create",
    });
    session.agent.streamFn = cacheTrace.wrapStreamFn(session.agent.streamFn);
  }

  // Anthropic Claude endpoints can reject replayed `thinking` blocks on
  // any follow-up provider call, including tool continuations. Sanitize
  // outbound messages where policy allows rewriting; otherwise preserve
  // latest thinking and let the recovery wrapper retry once without it.
  if (transcriptPolicy.dropThinkingBlocks || transcriptPolicy.dropReasoningFromHistory) {
    installStreamWrapper(wrapStreamFnWithMessageTransform, (messages) => {
      const reasoningSanitized = transcriptPolicy.dropReasoningFromHistory
        ? dropReasoningFromHistory(messages)
        : messages;
      return transcriptPolicy.dropThinkingBlocks
        ? dropThinkingBlocks(reasoningSanitized)
        : reasoningSanitized;
    });
  }
  if (
    transcriptPolicy.preserveSignatures ||
    transcriptPolicy.dropThinkingBlocks ||
    transcriptPolicy.dropReasoningFromHistory
  ) {
    installStreamWrapper(wrapAnthropicStreamWithRecovery, {
      id: session.sessionId,
      onRecoveredAnthropicThinking: () => repairRejectedReplay("thinking"),
    });
  }

  // Tool continuations bypass startup history sanitization; each request must
  // satisfy the provider's tool-call ID format and pairing rules.
  const replayToolCallIdSanitizerDecision = {
    sanitizeToolCallIds: transcriptPolicy.sanitizeToolCallIds,
    toolCallIdMode: transcriptPolicy.toolCallIdMode,
    isOpenAIResponsesApi,
  };
  if (shouldApplyReplayToolCallIdSanitizer(replayToolCallIdSanitizerDecision)) {
    const mode = replayToolCallIdSanitizerDecision.toolCallIdMode;
    installStreamWrapper(wrapStreamFnWithMessageTransform, (messages, model) =>
      sanitizeReplayToolCallIdsForStream({
        messages,
        mode,
        allowedToolNames: replayAllowedToolNames,
        preserveNativeAnthropicToolUseIds: transcriptPolicy.preserveNativeAnthropicToolUseIds,
        duplicateToolCallIdStyle: transcriptPolicy.duplicateToolCallIdStyle,
        preserveReplaySafeThinkingToolCallIds: shouldAllowProviderOwnedThinkingReplay({
          modelApi: model.api,
          provider: attempt.provider,
          policy: transcriptPolicy,
        }),
        repairToolUseResultPairing: transcriptPolicy.repairToolUseResultPairing,
      }),
    );
  }

  // Responses and eligible Anthropic routes replay provider checkpoints; a rejected one must be
  // stripped from its transcript owner or every later turn resends it.
  if (isOpenAIResponsesApi || compactionReplayEnabled) {
    installStreamWrapper(wrapStreamFnWithCompactionReplayRepair, (checkpoint) =>
      repairRejectedReplay("compaction", checkpoint),
    );
  }
  if (isOpenAIResponsesApi) {
    installStreamWrapper(wrapStreamFnWithMessageTransform, sanitizeOpenAIResponsesReplayForStream);
  }

  const innerStreamFn = session.agent.streamFn;
  session.agent.streamFn = (model, context, options) => {
    if (
      input.lifecycle.readYieldState().yieldDetected &&
      abortSignal.aborted &&
      isSessionsYieldAbortReason(abortSignal.reason)
    ) {
      return createYieldAbortedResponse(model);
    }
    return innerStreamFn(model, context, options);
  };

  installStreamWrapper(
    wrapStreamFnSanitizeMalformedToolCalls,
    replayAllowedToolNames,
    transcriptPolicy,
    attempt.provider,
  );
  installStreamWrapper(wrapStreamFnPromoteStandaloneTextToolCalls, liveAllowedToolNames);
  installStreamWrapper(wrapStreamFnTrimToolCallNames, liveAllowedToolNames, {
    // Unknown-tool recovery stays active even when configurable loop detection is disabled.
    unknownToolThreshold: UNKNOWN_TOOL_THRESHOLD,
  });

  if (
    shouldRepairMalformedToolCallArguments({
      provider: attempt.provider,
      modelApi: attempt.model.api,
    })
  ) {
    installStreamWrapper(wrapStreamFnRepairMalformedToolCallArguments);
  }

  if (resolveToolCallArgumentsEncoding(attempt.model) === "html-entities") {
    installStreamWrapper(createHtmlEntityToolCallArgumentDecodingWrapper);
  }

  // Tool-call repair can replace structured arguments from fragmented deltas.
  // Restore provider-masked text afterward so executable args stay canonical.
  if (providerTextTransforms?.output?.length) {
    session.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: session.agent.streamFn,
      output: providerTextTransforms.output,
    });
  }

  if (anthropicPayloadLogger) {
    session.agent.streamFn = anthropicPayloadLogger.wrapStreamFn(session.agent.streamFn);
  }
  // Anthropic-compatible providers can add new stop reasons before shared model runtime maps them.
  // Recover the known "sensitive" stop reason here so a model refusal does not
  // bubble out as an uncaught runner error and stall channel polling.
  installStreamWrapper(wrapStreamFnHandleSensitiveStopReason);

  // An explicit override remains intentional even when it equals the default.
  // Older callers only communicate the override through a different value.
  const configuredRunTimeoutMs = resolveAgentTimeoutMs({
    cfg: attempt.config,
  });
  const resolvedRunTimeoutMs =
    attempt.runTimeoutOverrideMs ??
    (attempt.timeoutMs !== configuredRunTimeoutMs ? attempt.timeoutMs : undefined);
  const timeoutOptions = {
    cfg: attempt.config,
    runTimeoutMs: resolvedRunTimeoutMs,
    modelRequestTimeoutMs: (attempt.model as { requestTimeoutMs?: number }).requestTimeoutMs,
    model: { baseUrl: attempt.model.baseUrl, id: attempt.modelId, provider: attempt.provider },
  };
  const idleTimeoutMs = resolveLlmIdleTimeoutMs({ ...timeoutOptions, trigger: attempt.trigger });
  const firstEventTimeoutMs = resolveLlmFirstEventTimeoutMs(timeoutOptions);
  if (idleTimeoutMs > 0 || firstEventTimeoutMs > 0) {
    // Local providers opt out of gap policing, but stream creation still needs
    // a deadline when response headers never arrive.
    installStreamWrapper(
      streamWithIdleTimeout,
      idleTimeoutMs > 0 ? idleTimeoutMs : firstEventTimeoutMs,
      (error) => callbacks.onIdleTimeout(error),
      idleTimeoutMs > 0
        ? { runId: attempt.runId }
        : { runId: attempt.runId, scope: "creation-only" },
    );
  }
  if (firstEventTimeoutMs > 0) {
    const baseStreamFn = session.agent.streamFn;
    session.agent.streamFn = (model, context, options) => {
      const optionsWithFirstEvent = options as FirstStreamEventInternalOptions | undefined;
      return baseStreamFn(model, context, {
        ...options,
        firstEventTimeoutMs: optionsWithFirstEvent?.firstEventTimeoutMs ?? firstEventTimeoutMs,
        onFirstEventTimeout: optionsWithFirstEvent?.onFirstEventTimeout ?? callbacks.onIdleTimeout,
      } as typeof options);
    };
  }
  let diagnosticModelCallSeq = 0;
  let modelResponseTerminal = false;
  let activeModelCallId: string | undefined;
  installStreamWrapper(wrapStreamFnWithDiagnosticModelCallEvents, {
    config: attempt.config,
    runId: attempt.runId,
    agentId: sessionAgentId,
    ...(attempt.sessionKey && { sessionKey: attempt.sessionKey }),
    ...(attempt.sessionId && { sessionId: attempt.sessionId }),
    provider: attempt.provider,
    model: attempt.modelId,
    api: attempt.model.api,
    transport: effectiveAgentTransport,
    // No-gap local inference remains recoverable at its existing transport deadline.
    requestTimeoutMs:
      idleTimeoutMs || Math.min(attempt.timeoutMs, DEFAULT_UNDICI_STREAM_TIMEOUT_MS),
    ...(attempt.contextWindowInfo?.tokens
      ? { contextTokenBudget: attempt.contextWindowInfo.tokens }
      : {}),
    ...(attempt.contextWindowInfo?.source
      ? { contextWindowSource: attempt.contextWindowInfo.source }
      : {}),
    ...(attempt.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: attempt.contextWindowInfo.referenceTokens }
      : {}),
    trace: input.diagnostics.runTrace,
    contentCapture: resolveDiagnosticModelContentCapturePolicy(attempt.config),
    nextCallId: () => `${attempt.runId}:model:${(diagnosticModelCallSeq += 1)}`,
    ownerGeneration: callbacks.diagnosticOwner.generation,
    onSucceeded: contextGuards.recordCacheTouch,
    onTerminal: () => {
      modelResponseTerminal = true;
    },
    onFinished: (callId) => {
      if (activeModelCallId === callId) {
        activeModelCallId = undefined;
      }
    },
    onStarted: (callId) => {
      activeModelCallId = callId;
      modelResponseTerminal = false;
      attempt.onExecutionPhase?.({
        phase: "model_call_started",
        provider: attempt.provider,
        model: attempt.modelId,
        firstModelCallStarted: true,
      });
    },
    suppressPluginHooks: attempt.operation === "settled-tool-finalization",
  });
  if (codeModeExecToolNames?.size) {
    installStreamWrapper(wrapStreamFnCodeModeSource, codeModeExecToolNames);
  }
  return {
    onModelRequest: (...args: Parameters<typeof cacheObserver.onModelRequest>) => {
      const previous = cacheObserver.getContextUsage();
      const request = cacheObserver.onModelRequest(...args);
      if (request.requestIndex > 1) {
        contextGuards.checkMidTurnPrecheck({
          context: args[1],
          previousRequest:
            previous?.requestIndex === request.requestIndex - 1 &&
            request.prefixUnchanged &&
            (request.changes ?? []).every(
              ({ code }) => code === "pruning" || code === "aggregateToolResultTruncation",
            )
              ? previous
              : undefined,
        });
      }
    },
    onModelUsage: (
      usage: NormalizedUsage | undefined,
      identity?: Pick<AssistantMessage, "responseId" | "turnId">,
    ) => {
      // Async-tool fragments also end messages. result() marks the terminal
      // response before core commits its final fragment with normalized usage.
      if (modelResponseTerminal) {
        modelResponseTerminal = false;
        cacheObserver.onModelUsage(usage, providerPromptState.lastAttempt, identity);
      }
    },
    getPromptCacheObservation: cacheObserver.getObservation,
    isModelCallActive: () => activeModelCallId !== undefined,
  };
}
