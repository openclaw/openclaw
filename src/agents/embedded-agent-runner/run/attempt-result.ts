import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isPlainTextToolCallAttempt } from "../../../../packages/tool-call-repair/src/index.js";
import { freezeDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { isTransientNetworkError } from "../../../infra/retryable-network-errors.js";
import { extractAssistantTranscriptSourceText } from "../../../shared/chat-message-content.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { prepareTerminalAssistantReply } from "../../assistant-terminal-reply.js";
import type { CompletedAssistantAnswer } from "../../embedded-agent-subscribe.handlers.types.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { isCloudCodeAssistFormatError } from "../../failover/classify-core.js";
import {
  INCOMPLETE_ASSISTANT_STREAM_RE,
  TERMINATED_TRANSPORT_MESSAGE_RE,
} from "../../failover/message-patterns.js";
import { resolveReplyExpectation } from "../../reply-completion.js";
import type { AgentRuntimeModelAttempt } from "../../runtime-plan/types.js";
import { markCoreTtsAttemptResult } from "../../tools/tts-tool-result-provenance.js";
import { log } from "../logger.js";
import { observeReplayMetadata, replayMetadataFromState } from "../replay-state.js";
import { buildEmbeddedAgentHookContext } from "./agent-hook-context.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import { finalizeEmbeddedAttempt } from "./attempt-finalize.js";
import type { EmbeddedAttemptPromptState } from "./attempt-prompt-phase.js";
import type { PreparedStreamRuntime } from "./attempt-stream-runtime.types.js";
import type { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import {
  buildAttemptReplayMetadata,
  hasAttemptTerminalState,
  resolveCurrentAttemptAssistant,
} from "./attempt-terminal-evidence.js";
import { isRunnerToolCallBlock } from "./attempt-tool-call-block-type.js";
import { resolveToolCallName } from "./attempt-tool-call-name-resolution.js";
import { hasComposedVisibleAnswerAfterSettledTools } from "./incomplete-turn-classification.js";
import { shouldTreatEmptyAssistantReplyAsSilent } from "./incomplete-turn-recovery.js";
import { readSubscriptionCompletionEvidence } from "./subscription-completion-evidence.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;

/** Keeps attempt-owned state available while retry attempts replace their result object. */
export function createAttemptCarryover() {
  let latestMcpAppChannelView: EmbeddedRunAttemptResult["latestMcpAppChannelView"];
  let latestMcpConnectAction: EmbeddedRunAttemptResult["latestMcpConnectAction"];
  let modelAttempt: AgentRuntimeModelAttempt | undefined;
  return {
    apply(
      attempt: Pick<
        EmbeddedRunAttemptResult,
        "latestMcpAppChannelView" | "latestMcpConnectAction" | "modelAttempt"
      >,
    ): void {
      modelAttempt = attempt.modelAttempt;
      latestMcpAppChannelView = attempt.latestMcpAppChannelView ?? latestMcpAppChannelView;
      attempt.latestMcpAppChannelView = latestMcpAppChannelView;
      latestMcpConnectAction = attempt.latestMcpConnectAction ?? latestMcpConnectAction;
      attempt.latestMcpConnectAction = latestMcpConnectAction;
    },
    get modelAttempt() {
      return modelAttempt;
    },
  };
}

export type EmbeddedRunAttemptWithReceiptEvidence = EmbeddedRunAttemptResult & {
  answerSegments?: EmbeddedAttemptSubscription["answerSegments"];
  keptAnswer?: CompletedAssistantAnswer;
  successfulNestedToolNames?: string[];
};

/**
 * Captures the settled transcript the tool-free finalizer needs when a settled
 * post-tool turn dies on its final provider call. The consumer fails closed
 * without this context, so the attempt-result owner has to supply it; the codex
 * app-server harness already does the same for its own attempts.
 */
function resolveSettledTurnFinalizationContext(params: {
  assistant: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  assistantTexts: readonly string[];
  messagesSnapshot: EmbeddedRunAttemptResult["messagesSnapshot"];
  terminal: EmbeddedRunAttemptResult["terminal"];
}): EmbeddedRunAttemptResult["settledTurnFinalizationContext"] {
  const terminal = projectAgentRunAttemptTerminal(params.terminal);
  const failure =
    terminal.promptErrorSource === "prompt"
      ? terminal.promptError
      : params.assistant?.stopReason === "error"
        ? { message: params.assistant.errorMessage, code: params.assistant.errorCode }
        : undefined;
  // Providers can report their terminal failure either by throwing or through
  // the completed assistant. Both forms must use the same transient policy.
  if (
    terminal.aborted ||
    terminal.timedOut ||
    terminal.timedOutDuringCompaction ||
    terminal.timedOutDuringToolExecution ||
    (terminal.promptErrorSource !== null && terminal.promptErrorSource !== "prompt") ||
    !isTransientSettledTurnFailure(failure)
  ) {
    return undefined;
  }
  // Pre-tool commentary is not a final answer. Only text after the last tool
  // result, or subscription text that cannot be attributed to that commentary,
  // means the turn already composed something to keep.
  if (hasComposedVisibleAnswerAfterSettledTools(params)) {
    return undefined;
  }
  if (!params.messagesSnapshot.some((message) => message.role === "toolResult")) {
    return undefined;
  }
  return {
    source: "openclaw-transcript",
    messages: Object.freeze([...params.messagesSnapshot]),
  };
}

function isTransientSettledTurnFailure(failure: unknown): boolean {
  if (isTransientNetworkError(failure)) {
    return true;
  }
  const message =
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string"
      ? failure.message.trim()
      : "";
  // A projected bare `terminated` can lack a retryable code. Keep settled tools
  // eligible for the existing tool-free finalizer.
  return (
    INCOMPLETE_ASSISTANT_STREAM_RE.test(message) || TERMINATED_TRANSPORT_MESSAGE_RE.test(message)
  );
}

export function completeEmbeddedAttemptResult(
  input: EmbeddedAttemptExecutionPhaseInput & { preparedStreamRuntime: PreparedStreamRuntime },
  settled: Awaited<ReturnType<typeof settleEmbeddedAttemptStream>>,
  prompt: EmbeddedAttemptPromptState &
    Pick<
      EmbeddedRunAttemptResult,
      "messagesSnapshot" | "sessionIdUsed" | "sessionFileUsed" | "beforeAgentFinalizeRevisionReason"
    >,
): EmbeddedRunAttemptWithReceiptEvidence {
  const { attempt } = input;
  const { sessionRuntime, bootstrap, systemPrompt } = input.prepared;
  const {
    agentSession: { clientToolCallSlots, hasDeliveredSourceReply, hookRunner },
    trajectoryRecorder,
  } = sessionRuntime;
  const { subscription, deferredLifecycleOwner } = input.preparedStreamRuntime.stream;
  const { bootstrapPromptWarning } = bootstrap;
  const hookAgentId = input.setup.sessionAgentId;
  // Output hooks can reenter the runtime; project only the state settled before they run.
  const state = {
    terminal: input.state.terminal,
    preflightRecovery: prompt.preflightRecovery,
    sessionIdUsed: prompt.sessionIdUsed,
    sessionFileUsed: prompt.sessionFileUsed,
    diagnosticTrace: input.diagnostics.diagnosticTrace,
    systemPromptReport: systemPrompt.systemPromptReport,
    finalPromptText: prompt.finalPromptText,
    messagesSnapshot: prompt.messagesSnapshot,
    ...(prompt.beforeAgentFinalizeRevisionReason
      ? { beforeAgentFinalizeRevisionReason: prompt.beforeAgentFinalizeRevisionReason }
      : {}),
    lastAssistant: settled.lastAssistant,
    currentAttemptAssistant: settled.currentAttemptAssistant,
    currentAttemptCompletedAssistant: settled.currentAttemptCompletedAssistant,
    hasSuccessfulModelResponse: subscription.hasSuccessfulModelResponse(),
    successfulNestedToolNames: settled.successfulNestedToolNames,
    attemptUsage: settled.attemptUsage,
    promptCache: sessionRuntime.state.promptCache,
    contextBudgetStatus: prompt.contextBudgetStatus,
    yieldDetected: input.lifecycle.readYieldState().yieldDetected,
    yieldAcknowledgment: input.lifecycle.readYieldState().yieldAcknowledgment,
    yieldMessageWaitRegistered: input.lifecycle.readYieldState().yieldMessageWaitRegistered,
    didDeliverSourceReplyViaMessageTool: hasDeliveredSourceReply(),
  };
  const terminal = projectAgentRunAttemptTerminal(state.terminal);
  const { assistantTexts, setTerminalLifecycleMeta } = subscription;
  const evidence = readSubscriptionCompletionEvidence(subscription);

  if (
    attempt.operation !== "settled-tool-finalization" &&
    hookRunner?.hasHooks("llm_output") &&
    terminal.promptErrorSource !== "hook:before_agent_run"
  ) {
    const contextWindow = {
      ...(attempt.contextWindowInfo?.tokens
        ? { contextTokenBudget: attempt.contextWindowInfo.tokens }
        : {}),
      ...(attempt.contextWindowInfo?.source
        ? { contextWindowSource: attempt.contextWindowInfo.source }
        : {}),
      ...(attempt.contextWindowInfo?.referenceTokens
        ? { contextWindowReferenceTokens: attempt.contextWindowInfo.referenceTokens }
        : {}),
    };
    hookRunner
      .runLlmOutput(
        {
          runId: attempt.runId,
          sessionId: attempt.sessionId,
          provider: attempt.provider,
          model: attempt.modelId,
          ...contextWindow,
          resolvedRef:
            attempt.runtimePlan?.observability.resolvedRef ??
            `${attempt.provider}/${attempt.modelId}`,
          ...(attempt.runtimePlan?.observability.harnessId
            ? { harnessId: attempt.runtimePlan.observability.harnessId }
            : {}),
          assistantTexts,
          lastAssistant: state.lastAssistant,
          usage: state.attemptUsage,
        },
        {
          ...buildEmbeddedAgentHookContext(
            attempt,
            hookAgentId,
            freezeDiagnosticTraceContext(state.diagnosticTrace),
          ),
          ...contextWindow,
        },
      )
      .catch((err: unknown) => {
        log.warn(`llm_output hook failed: ${String(err)}`);
      });
  }

  const { messagingToolSentMediaUrls } = evidence;
  const sentMediaUrls = new Set(messagingToolSentMediaUrls.map((url) => url.trim()));
  const toolAutoDeliveryMediaUrls = subscription
    .getToolAutoDeliveryMediaUrls()
    .filter((url) => !sentMediaUrls.has(url.trim()));
  // Structured start arguments already updated replayState for mutations and async work.
  // Reclassifying by tool name would incorrectly mark read-only cron actions as unsafe.
  const observedReplayMetadata = buildAttemptReplayMetadata({ ...evidence, toolMetas: [] });
  const replayMetadata = replayMetadataFromState(
    observeReplayMetadata(subscription.getReplayState(), observedReplayMetadata),
  );
  const currentAttemptReplayMetadata = buildAttemptReplayMetadata(evidence);
  const completedClientToolCalls = clientToolCallSlots.flatMap((slot) =>
    slot.completed && slot.params ? [{ name: slot.name, params: slot.params }] : [],
  );
  const clientToolCalls =
    completedClientToolCalls.length > 0 ? completedClientToolCalls : undefined;
  // The runtime has settled. Progress sent as the last tool batch was written
  // after every other tool result; an empty stop after it is the reply.
  const terminalAssistant = state.currentAttemptCompletedAssistant ?? state.currentAttemptAssistant;
  const closingReply = prepareTerminalAssistantReply(terminalAssistant);
  const progressIsReply =
    subscription.endsWithSourceProgress() &&
    resolveReplyExpectation(attempt) !== "result-required" &&
    state.terminal.kind === "ok" &&
    terminalAssistant?.stopReason === "stop" &&
    closingReply.terminalReply.disposition !== "visible";
  const completeLastProgress = <T extends { sourceReplyFinal?: boolean }>(sends: T[]): T[] => {
    const index = sends.findLastIndex((send) => send.sourceReplyFinal === false);
    return progressIsReply && index >= 0
      ? sends.with(index, Object.assign({}, sends[index], { sourceReplyFinal: true }))
      : sends;
  };
  const messagingToolSourceReplyPayloads = completeLastProgress(
    evidence.messagingToolSourceReplyPayloads,
  );
  const settledTurnFinalizationContext = resolveSettledTurnFinalizationContext({
    assistant: state.currentAttemptCompletedAssistant ?? state.currentAttemptAssistant,
    assistantTexts,
    messagesSnapshot: state.messagesSnapshot,
    terminal: state.terminal,
  });
  const keptAnswer = evidence.keptAnswer;
  const keptReply = keptAnswer ? prepareTerminalAssistantReply(keptAnswer.assistant) : closingReply;
  const assistant = resolveCurrentAttemptAssistant(state);
  let textToolCallAttempt = false;
  if (
    state.terminal.kind === "ok" &&
    assistant?.stopReason === "stop" &&
    !assistant.content.some(isRunnerToolCallBlock)
  ) {
    const allowedToolNames = input.prepared.toolCatalog.toolSearchRunPlan.liveAllowedToolNames;
    textToolCallAttempt =
      allowedToolNames.size > 0 &&
      isPlainTextToolCallAttempt(extractAssistantTranscriptSourceText(assistant) ?? "", (name) =>
        Boolean(resolveToolCallName(name, allowedToolNames, undefined, true)),
      );
  }
  const accessProgram = asOptionalRecord(
    sessionRuntime.transport.effectiveExtraParams.accessPrograms,
  )?.cyber;
  const result: EmbeddedRunAttemptWithReceiptEvidence = {
    ...(accessProgram === "standard" ||
    accessProgram === "daybreak_blue" ||
    accessProgram === "daybreak_red"
      ? { cyberAccessProgram: accessProgram }
      : {}),
    ...(textToolCallAttempt ? { textToolCallAttempt: true } : {}),
    ...state,
    ...evidence,
    preparedTerminalReply: keptReply,
    sandboxRuntime: input.setup.sandboxRuntime,
    ...(settledTurnFinalizationContext ? { settledTurnFinalizationContext } : {}),
    replayMetadata,
    currentAttemptReplayMetadata,
    assistantTurns: subscription.getAssistantTurnCount(),
    setTerminalLifecycleMeta,
    bootstrapPromptWarningSignaturesSeen: bootstrapPromptWarning.warningSignaturesSeen,
    bootstrapPromptWarningSignature: bootstrapPromptWarning.signature,
    answerSegments: subscription.answerSegments,
    latestMcpAppChannelView: subscription.getLatestMcpAppChannelView(),
    latestMcpConnectAction: subscription.getLatestMcpConnectAction(),
    lastAssistantTextMessageIndex: subscription.getLastAssistantTextMessageIndex(),
    messagingToolSentTargets: completeLastProgress(evidence.messagingToolSentTargets),
    messagingToolSourceReplyPayloads,
    sourceReplyDeliveryState: progressIsReply ? "delivered" : evidence.sourceReplyDeliveryState,
    cloudCodeAssistFormatError: Boolean(
      state.lastAssistant?.errorMessage &&
      isCloudCodeAssistFormatError(state.lastAssistant.errorMessage),
    ),
    compactionCount: subscription.getCompactionCount(),
    compactionTokensAfter: subscription.getLastCompactionTokensAfter(),
    clientToolCalls,
    yieldDetected: state.yieldDetected || undefined,
  };
  const resultEvidence = { ...result, yieldDetected: state.yieldDetected };
  // The coarse messaging flag was never terminal evidence at this boundary.
  const { didSendViaMessagingTool: _coarseDelivery, ...terminalEvidence } = resultEvidence;
  const hasTerminalOutput = hasAttemptTerminalState(terminalEvidence);
  const pendingToolMediaPayloadCount =
    evidence.toolMediaUrls?.some((url) => url.trim().length > 0) ||
    evidence.toolAudioAsVoice === true
      ? 1
      : 0;
  const visibleBlockReplyCount = subscription.getVisibleBlockReplyCount();
  const synthesizedPayloadCount =
    visibleBlockReplyCount + pendingToolMediaPayloadCount + messagingToolSourceReplyPayloads.length;
  const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
    terminalReplyExpectation: resolveReplyExpectation(attempt),
    payloadCount: 0,
    aborted: terminal.aborted,
    timedOut: terminal.timedOut,
    attempt: resultEvidence,
  });
  const resultWithAutoDeliveryMedia =
    toolAutoDeliveryMediaUrls.length > 0
      ? markCoreTtsAttemptResult(
          result,
          toolAutoDeliveryMediaUrls,
          attempt.admittedRunContext.operationalRunInstance,
        )
      : result;
  return finalizeEmbeddedAttempt({
    result: resultWithAutoDeliveryMedia,
    trajectoryRecorder,
    deferredLifecycleOwner,
    synthesizedPayloadCount,
    emptyAssistantReplyIsSilent,
    hasTerminalOutput,
    silentExpected: attempt.silentExpected,
  });
}
