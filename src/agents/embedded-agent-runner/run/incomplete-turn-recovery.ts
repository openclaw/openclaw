import { isResponsesOutputLimitToolCallError } from "@openclaw/ai/diagnostics";
import { hasOnlyAssistantReasoningContent } from "@openclaw/ai/internal/shared";
import { MALFORMED_TOOL_CALL_ARGUMENTS_ERROR_CODE } from "../../../llm/types.js";
import { isTerminalAssistantError } from "../../../llm/utils/retry.js";
import { hasAcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import { isPreDispatchToolCallRejectionMessage } from "../../failover/message-patterns.js";
import {
  resolveReplyCompletion,
  resolveReplyExpectation,
  type ReplyDeliveryState,
  type ReplyExpectation,
} from "../../reply-completion.js";
import { readToolEffectReceipt } from "../../tool-effect-receipt.js";
import { TOOL_FAILURE_INSTRUCTION } from "../../tool-outcome-instructions.js";
import { isZeroUsageEmptyStopAssistantTurn } from "../empty-assistant-turn.js";
import { assessLastAssistantMessage } from "../thinking.js";
import {
  hasAsyncActivity,
  hasAttemptTerminalState,
  isCurrentAttemptReplaySafe,
  resolveCurrentAttemptAssistant,
} from "./attempt-terminal-evidence.js";
import {
  classifyAssistantTurn,
  hasPositiveOutputTokenUsage,
  isOllamaIncompleteTurnProvider,
  joinAssistantTexts,
  shouldApplyNonVisibleTurnRetryGuard,
  type IncompleteTurnAttempt,
} from "./incomplete-turn-classification.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

// Allow one immediate continuation plus one follow-up continuation before
// surfacing the existing incomplete-turn error path.
export const DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2;
export const DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT = 1;
const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
const EMPTY_RESPONSE_RETRY_INSTRUCTION =
  "Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current state; do not restart from scratch.";
const REQUIRED_RESULT_RETRY_INSTRUCTION =
  "Your turn ended without a final result. Continue from the current state and produce the required result now. NO_REPLY is not allowed. Do not restart from scratch.";
const TEXT_TOOL_CALL_RETRY_INSTRUCTION =
  "You wrote a tool call as text, so nothing ran for that call. Continue from the current state and call the tool natively through the tool interface. Do not print tool-call JSON or markup as your answer.";
const TOOL_USE_WITHOUT_CALL_RETRY_INSTRUCTION =
  "The previous assistant turn stopped for tool use but contained no tool call, so nothing ran. Continue from the current state: call the tool you need through the tool interface instead of writing the call as text, or produce the visible answer now. Do not restart from scratch.";
const REJECTED_TOOL_CALL_RETRY_INSTRUCTION =
  "The previous assistant turn's tool call was rejected before it ran because the provider returned incomplete or malformed tool-call arguments, so nothing ran for that call. Continue from the current state: re-issue the call you need through the tool interface with complete, valid JSON arguments, or produce the visible answer now. Do not repeat completed tool calls or restart from scratch.";
const SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "Your turn ended without a final reply. If the user still needs a reply, write it now. If your completed actions already answered the request, answer exactly NO_REPLY. Continue from the current transcript. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";
const REQUIRED_RESULT_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "Your turn ended without a final result. Continue from the current transcript and produce the required result now. NO_REPLY is not allowed. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";
const READ_ONLY_TOOL_CONTINUATION_INSTRUCTION =
  "Your turn ended before completing the task. Continue from the current transcript, using tools for any remaining work, then produce the final reply. Do not repeat completed tool calls or restart from scratch.";

type IncompleteTurnRecoveryParams = {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  executionContract?: string;
  terminalReplyExpectation?: ReplyExpectation;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
};

export function shouldRetrySilentErrorAssistantTurn(params: {
  attempt: Pick<
    EmbeddedRunAttemptResult,
    | "assistantTexts"
    | "clientToolCalls"
    | "yieldDetected"
    | "didSendDeterministicApprovalPrompt"
    | "heartbeatToolResponse"
    | "lastToolError"
    | "toolMediaUrls"
    | "toolAudioAsVoice"
    | "toolTrustedLocalMedia"
    | "didDeliverSourceReplyViaMessageTool"
    | "messagingToolSourceReplyPayloads"
    | "replayMetadata"
    | "currentAttemptReplayMetadata"
  >;
  assistant: EmbeddedRunAttemptResult["lastAssistant"] | null | undefined;
}): boolean {
  // Current-attempt evidence avoids blocking on prior committed effects; older
  // harnesses retain the cumulative, fail-closed behavior.
  if (
    joinAssistantTexts(params.attempt.assistantTexts).length > 0 ||
    hasAttemptTerminalState(params.attempt) ||
    !isCurrentAttemptReplaySafe(params.attempt)
  ) {
    return false;
  }

  const assistant = params.assistant;
  if (
    !assistant ||
    assistant.stopReason !== "error" ||
    isTerminalAssistantError(assistant) ||
    // Output-limit continuation has already consulted the shared recovery budget.
    isResponsesOutputLimitToolCallError(assistant)
  ) {
    return false;
  }

  const { content } = assistant;
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.every((block) => block.type === "text" && !block.text.trim())) {
    // Rejected arguments can consume tokens without output; the preceding guards own replay safety.
    return (
      !hasPositiveOutputTokenUsage(assistant) ||
      assistant.errorCode === MALFORMED_TOOL_CALL_ARGUMENTS_ERROR_CODE ||
      isPreDispatchToolCallRejectionMessage(assistant.errorMessage)
    );
  }

  return hasOnlyAssistantReasoningContent(assistant);
}

function shouldSkipNonVisibleTurnRetry(params: {
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
  /** Silent classification can tolerate completed effects, never unfinished work or replay. */
  tolerateSideEffects?: boolean;
  consumedToolFailure?: boolean;
}): boolean {
  return Boolean(
    params.aborted ||
    params.timedOut ||
    params.attempt.terminal.kind === "failed" ||
    params.attempt.clientToolCalls ||
    params.attempt.yieldDetected ||
    params.attempt.didSendDeterministicApprovalPrompt ||
    (params.attempt.lastToolError && !params.consumedToolFailure) ||
    hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns) ||
    params.attempt.itemLifecycle.activeCount > 0 ||
    params.attempt.itemLifecycle.completedCount < params.attempt.itemLifecycle.startedCount ||
    hasAsyncActivity(params.attempt.toolMetas) ||
    (params.tolerateSideEffects !== true && params.attempt.replayMetadata.hadPotentialSideEffects),
  );
}

/** A final stop may author silence independently of prior external effects and delivery custody. */
export function shouldTreatEmptyAssistantReplyAsSilent(params: {
  allowEmptyAssistantReplyAsSilent?: boolean;
  terminalReplyExpectation?: ReplyExpectation;
  payloadCount: number;
  aborted: boolean;
  timedOut: boolean;
  attempt: IncompleteTurnAttempt;
}): boolean {
  const assistant = classifyAssistantTurn(params);
  const completion = resolveReplyCompletion(
    resolveReplyExpectation(params),
    assistant.silent ? "silent" : params.payloadCount === 0 ? "empty" : "ready",
  );
  return (
    completion.outcome === "silent" &&
    !params.aborted &&
    !params.timedOut &&
    params.attempt.terminal.kind !== "failed" &&
    assistant.silent &&
    assistant.assistant?.stopReason === "stop"
  );
}

/**
 * Builds the retry instruction for reasoning-only turns that consumed provider
 * output budget but produced no visible assistant text.
 */
function resolveReasoningOnlyRetryInstruction(params: IncompleteTurnRecoveryParams): string | null {
  if (shouldSkipNonVisibleTurnRetry(params) || !shouldApplyNonVisibleTurnRetryGuard(params)) {
    return null;
  }

  const assistant = resolveCurrentAttemptAssistant(params.attempt);
  // Unsigned thinking blocks have no cryptographic signature; assessLastAssistantMessage
  // returns "incomplete-thinking" for them. Empty content also returns "incomplete-thinking",
  // so the content.length > 0 guard is required to distinguish the two cases.
  return joinAssistantTexts(params.attempt.assistantTexts).length === 0 &&
    assistant &&
    assistant.stopReason !== "error" &&
    !assistant.openclawDelivery?.tts?.text?.trim() &&
    Array.isArray(assistant.content) &&
    assistant.content.length > 0 &&
    assessLastAssistantMessage(assistant) !== "valid"
    ? REASONING_ONLY_RETRY_INSTRUCTION
    : null;
}

type SettledToolCall = { id: string | null; name: string | null };
type SettledToolResult = { toolCallId?: unknown; toolName?: unknown; isError?: unknown };

function readSettledToolCalls(
  message: EmbeddedRunAttemptResult["currentAttemptAssistant"] | null | undefined,
): SettledToolCall[] {
  if (!Array.isArray(message?.content)) {
    return [];
  }
  return message.content.flatMap((item) => {
    const block = item as { type?: unknown; id?: unknown; name?: unknown } | null;
    return block?.type === "toolCall"
      ? [
          {
            id: typeof block.id === "string" ? block.id : null,
            name: typeof block.name === "string" ? block.name : null,
          },
        ]
      : [];
  });
}

/** Proves settlement and intentional termination for the exact current-turn tool-call batch. */
export function resolveSettledToolBatchEvidence(
  attempt: Pick<
    IncompleteTurnAttempt,
    "messagesSnapshot" | "currentAttemptAssistant" | "itemLifecycle" | "toolMetas" | "lastToolError"
  >,
  // Set only when the attempt stopped before its next model call: a user message after
  // the current attempt's batch was steered into this run and does not start a new turn.
  options?: { midTurn?: boolean },
) {
  const snapshot = attempt.messagesSnapshot ?? [];
  let assistant = attempt.currentAttemptAssistant;
  let assistantIndex = assistant ? snapshot.indexOf(assistant) : -1;
  const latestUserIndex = snapshot.findLastIndex(
    (message, index) =>
      message.role === "user" &&
      !(options?.midTurn && assistantIndex >= 0 && index > assistantIndex),
  );
  if (assistantIndex <= latestUserIndex || readSettledToolCalls(assistant).length === 0) {
    assistantIndex = snapshot.findLastIndex(
      (message, index) =>
        index > latestUserIndex &&
        message.role === "assistant" &&
        readSettledToolCalls(message).length > 0,
    );
    const candidate = assistantIndex >= 0 ? snapshot[assistantIndex] : undefined;
    assistant = candidate?.role === "assistant" ? candidate : undefined;
  }
  const requestedToolCalls = readSettledToolCalls(assistant);
  // Results must follow their owning assistant; session-wide reused ids cannot settle a new turn.
  const settledToolResults = new Map(
    (assistantIndex >= 0 ? snapshot.slice(assistantIndex + 1) : []).flatMap((message) => {
      const { toolCallId, toolName, isError } = message as SettledToolResult;
      return message.role === "toolResult" &&
        typeof toolCallId === "string" &&
        typeof toolName === "string"
        ? [[toolCallId, { toolName, isError: isError === true }] as const]
        : [];
    }),
  );
  // Transcript proof: every call in the batch has its result persisted. Nested
  // code-mode work (exec status "waiting") keeps lifecycle items active while
  // the outer result is already recorded, so this is the weaker of the two.
  const allToolCallsRecorded =
    requestedToolCalls.length > 0 &&
    requestedToolCalls.every(
      ({ id, name }) =>
        id !== null && name !== null && settledToolResults.get(id)?.toolName === name,
    );
  const allToolsProvenSettled =
    allToolCallsRecorded &&
    attempt.itemLifecycle.startedCount > 0 &&
    attempt.itemLifecycle.completedCount === attempt.itemLifecycle.startedCount &&
    attempt.itemLifecycle.activeCount === 0;
  // Producer-recorded fact from the tool completion handler: one of this batch's
  // exec results parked a Code Mode run, which is the only legitimate reason a
  // fully recorded batch still shows active lifecycle items.
  const parkedCodeModeRun =
    allToolCallsRecorded &&
    requestedToolCalls.some(({ id }) =>
      attempt.toolMetas.some(
        (entry) => entry.toolCallId === id && entry.codeModeSuspended === true,
      ),
    );
  const failedToolNames = new Set(
    requestedToolCalls.flatMap(({ id, name }) =>
      id !== null && name !== null && settledToolResults.get(id)?.isError === true ? [name] : [],
    ),
  );
  const hasStaleToolError = Boolean(
    attempt.lastToolError &&
    assistant?.stopReason === "toolUse" &&
    allToolsProvenSettled &&
    failedToolNames.size === 0,
  );
  // ToolErrorSummary has no call id: its owner must match a failed result in the
  // proven terminal batch, or a stale/unrelated error could authorize continuation.
  // A fully settled successful batch proves that a retained error belongs to an
  // earlier tool and cannot block text-only finalization of the current batch.
  const hasUnsettledToolError = Boolean(
    attempt.lastToolError &&
    !hasStaleToolError &&
    (assistant?.stopReason !== "toolUse" ||
      !allToolsProvenSettled ||
      !failedToolNames.has(attempt.lastToolError.toolName)),
  );
  const intentionalTermination =
    allToolsProvenSettled &&
    assistant?.stopReason === "toolUse" &&
    failedToolNames.size === 0 &&
    !hasUnsettledToolError &&
    !hasAsyncActivity(attempt.toolMetas) &&
    requestedToolCalls.every(({ id, name }) => {
      const metadata = attempt.toolMetas.findLast(
        (entry) => entry.toolCallId === id && entry.toolName === name,
      );
      return metadata?.terminate === true && metadata.isError !== true;
    });
  return {
    assistant,
    allToolCallsRecorded,
    allToolsProvenSettled,
    parkedCodeModeRun,
    failedToolNames,
    hasStaleToolError,
    hasUnsettledToolError,
    intentionalTermination,
  };
}

/** Selects the instruction and tool policy for one continuation after settled tools. */
export function resolveSettledToolTerminalContinuation(
  params: IncompleteTurnRecoveryParams & {
    allowEmptyStopContinuation?: boolean;
    replyDeliveryState: ReplyDeliveryState;
    payloadCount: number;
    hasTerminalToolPresentation?: boolean;
  },
): { instruction: string; disableTools: boolean } | null {
  const { attempt } = params;
  const {
    assistant: toolBatchAssistant,
    allToolsProvenSettled,
    parkedCodeModeRun,
    failedToolNames,
    hasUnsettledToolError,
    intentionalTermination,
  } = resolveSettledToolBatchEvidence(attempt);
  const terminal = attempt.terminal;
  const idlePromptTimeout =
    terminal.kind === "timeout" &&
    terminal.phase === "prompt" &&
    terminal.source === "idle" &&
    attempt.currentAttemptReplayMetadata?.hadPotentialSideEffects === true;
  const assistantState = classifyAssistantTurn(params);
  // Signed reasoning may have no visible answer without being an empty response.
  const nonVisibleStopAfterSettledTools = Boolean(
    params.allowEmptyStopContinuation &&
    (assistantState.assistant?.stopReason === "stop" ||
      assistantState.assistant?.stopReason === "length") &&
    attempt.toolMetas.length > 0 &&
    attempt.toolMetas.every((tool) => tool.isError !== true && tool.asyncStarted !== true) &&
    attempt.itemLifecycle.startedCount > 0 &&
    attempt.itemLifecycle.completedCount === attempt.itemLifecycle.startedCount &&
    attempt.itemLifecycle.activeCount === 0 &&
    assistantState.visibleText.length === 0,
  );
  if (
    params.payloadCount !== 0 ||
    (assistantState.assistant?.stopReason === "stop" && assistantState.visibleText.length > 0) ||
    // Optional authored silence skips generation without clearing tool failure evidence.
    (!params.allowEmptyStopContinuation &&
      assistantState.silent &&
      assistantState.nonVisibleEligibleForSilentReply) ||
    params.hasTerminalToolPresentation ||
    params.aborted ||
    ((params.timedOut || terminal.kind === "timeout") && !idlePromptTimeout) ||
    (terminal.kind === "failed" && !attempt.settledTurnFinalizationContext) ||
    (toolBatchAssistant?.stopReason === "toolUse"
      ? !allToolsProvenSettled
      : !nonVisibleStopAfterSettledTools) ||
    intentionalTermination ||
    parkedCodeModeRun ||
    hasUnsettledToolError ||
    hasAsyncActivity(attempt.toolMetas) ||
    hasAcceptedSessionSpawn(attempt.acceptedSessionSpawns) ||
    attempt.clientToolCalls ||
    attempt.yieldDetected ||
    attempt.didSendDeterministicApprovalPrompt ||
    attempt.hasToolMediaBlockReply ||
    params.replyDeliveryState !== "missing" ||
    !shouldApplyNonVisibleTurnRetryGuard(params)
  ) {
    return null;
  }
  // Only explicit current-attempt evidence permits extending the work. The
  // isolated finalizer remains text-only after possible effects or missing evidence.
  const keepTools =
    (assistantState.assistant?.stopReason === "stop" ||
      assistantState.assistant?.stopReason === "length") &&
    assistantState.visibleText.length === 0 &&
    attempt.currentAttemptReplayMetadata?.hadPotentialSideEffects === false;
  const resultRequired = params.terminalReplyExpectation === "result-required";
  const instruction = keepTools
    ? `${READ_ONLY_TOOL_CONTINUATION_INSTRUCTION}${resultRequired ? " NO_REPLY is not allowed." : ""}`
    : resultRequired
      ? REQUIRED_RESULT_TOOL_TERMINAL_CONTINUATION_INSTRUCTION
      : SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION;
  return {
    instruction:
      allToolsProvenSettled && failedToolNames.size > 0
        ? `${instruction} ${TOOL_FAILURE_INSTRUCTION}`
        : instruction,
    disableTools: !keepTools,
  };
}

/**
 * Builds the retry instruction for empty assistant turns when the provider/model
 * is eligible for non-visible turn recovery.
 */
function resolveEmptyResponseRetryInstruction(
  params: IncompleteTurnRecoveryParams & {
    payloadCount: number;
    replyDeliveryState: ReplyDeliveryState;
  },
): string | null {
  const assistantState = classifyAssistantTurn(params);
  const assistant = assistantState.assistant ?? null;
  // A pre-dispatch rejection ran nothing. Error turns are never silent replies,
  // so inspect model output directly rather than the host's failure notice.
  const rejectedBeforeDispatch =
    params.attempt.itemLifecycle.completedCount > 0 &&
    assistantState.visibleText.length === 0 &&
    !params.attempt.hasToolMediaBlockReply &&
    params.replyDeliveryState === "missing" &&
    assistant?.stopReason === "error" &&
    (assistant.errorCode === MALFORMED_TOOL_CALL_ARGUMENTS_ERROR_CODE ||
      isPreDispatchToolCallRejectionMessage(assistant.errorMessage)) &&
    readSettledToolCalls(assistant).length === 0;
  let consumedToolFailure = false;
  if (rejectedBeforeDispatch && params.attempt.lastToolError?.executionStarted === false) {
    const messages = params.attempt.messagesSnapshot;
    const failureIndex = messages.findLastIndex(
      (message) => message.role === "toolResult" && message.isError,
    );
    const failure = messages[failureIndex];
    const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
    // A later refusal cannot erase an earlier failure that may have caused effects.
    consumedToolFailure =
      failureIndex > latestUserIndex &&
      failureIndex < messages.indexOf(assistant) &&
      failure?.role === "toolResult" &&
      failure.toolName === params.attempt.lastToolError.toolName &&
      messages
        .slice(latestUserIndex + 1, failureIndex + 1)
        .every(
          (message) =>
            message.role !== "toolResult" ||
            !message.isError ||
            readToolEffectReceipt(message)?.state === "not_started",
        );
  }
  if (
    shouldSkipNonVisibleTurnRetry({
      ...params,
      tolerateSideEffects: rejectedBeforeDispatch,
      consumedToolFailure,
    })
  ) {
    return null;
  }

  if (params.attempt.textToolCallAttempt) {
    return TEXT_TOOL_CALL_RETRY_INSTRUCTION;
  }

  // A tool-use stop with no structured call executed nothing; its text is not an answer.
  const toolUseWithoutCall =
    assistant?.stopReason === "toolUse" &&
    readSettledToolCalls(assistant).length === 0 &&
    params.attempt.toolMetas.length === 0 &&
    params.attempt.itemLifecycle.startedCount === 0;
  if (!assistantState.emptyResponse && !toolUseWithoutCall && !rejectedBeforeDispatch) {
    return null;
  }

  if (
    assistant?.stopReason === "stop" &&
    isOllamaIncompleteTurnProvider(params.provider) &&
    !hasPositiveOutputTokenUsage(assistant)
  ) {
    return null;
  }

  if (
    shouldApplyNonVisibleTurnRetryGuard(params) ||
    // Keep the generic zero-usage stop retry for providers that expose a
    // provider-neutral "nothing was generated" signal, even outside the
    // provider allowlist above.
    isZeroUsageEmptyStopAssistantTurn(assistant)
  ) {
    if (rejectedBeforeDispatch) {
      return REJECTED_TOOL_CALL_RETRY_INSTRUCTION;
    }
    return toolUseWithoutCall
      ? TOOL_USE_WITHOUT_CALL_RETRY_INSTRUCTION
      : params.terminalReplyExpectation === "result-required"
        ? REQUIRED_RESULT_RETRY_INSTRUCTION
        : EMPTY_RESPONSE_RETRY_INSTRUCTION;
  }

  return null;
}

export function resolveNonVisibleTurnRetryInstructions(
  params: IncompleteTurnRecoveryParams & {
    payloadCount: number;
    replyDeliveryState: ReplyDeliveryState;
    settledToolPayloadCount: number;
    hasTerminalToolPresentation?: boolean;
  },
): [reasoningOnly: string | null, emptyResponse: string | null] {
  const settled = resolveSettledToolTerminalContinuation({
    ...params,
    payloadCount: params.settledToolPayloadCount,
    allowEmptyStopContinuation: true,
  });
  return settled?.disableTools === false
    ? [null, settled.instruction]
    : [resolveReasoningOnlyRetryInstruction(params), resolveEmptyResponseRetryInstruction(params)];
}
