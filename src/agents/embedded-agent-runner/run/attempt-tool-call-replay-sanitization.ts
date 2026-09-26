import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  normalizeOpenAIResponsesToolCallIds,
} from "../../embedded-agent-helpers/openai.js";
import {
  mergeConsecutiveUserMessages,
  shouldAllowProviderOwnedThinkingReplay,
  shouldMergeConsecutiveUserTurns,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../../embedded-agent-helpers/turns.js";
import type { AgentMessage, StreamFn } from "../../runtime/index.js";
import {
  sanitizeToolUseResultPairing,
  sanitizeToolUseResultPairingForModel,
} from "../../session-transcript-repair.js";
import { isThinkingLikeBlock } from "../../thinking-block.js";
import {
  extractToolCallsFromAssistant,
  extractToolResultIds,
  hasToolCallInput,
  sanitizeToolCallIdsForCloudCodeAssist,
  type ToolCallIdMode,
} from "../../tool-call-id.js";
import { createCompletedToolCallPredicate } from "../../tool-call-shared.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
import { isRunnerToolCallBlock } from "./attempt-tool-call-block-type.js";
import { resolveToolCallName } from "./attempt-tool-call-name-resolution.js";

const REPLAY_TOOL_CALL_NAME_MAX_CHARS = 64;

type ReplayToolCallSanitizeReport = {
  messages: AgentMessage[];
  droppedAssistantMessages: number;
};

function isReplaySafeThinkingTurn(
  content: unknown[],
  allowedToolNames: Set<string> | undefined,
  isCompleted: ReturnType<typeof createCompletedToolCallPredicate>,
): boolean {
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (!isRunnerToolCallBlock(block)) {
      continue;
    }
    const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
    if (!hasToolCallInput(block) || !toolCallId || seenToolCallIds.has(toolCallId)) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
    const rawName = typeof block.name === "string" ? block.name : "";
    const resolvedName = resolveReplayToolCallName(
      rawName,
      toolCallId,
      isCompleted(block) ? undefined : allowedToolNames,
    );
    if (!resolvedName || block.name !== resolvedName) {
      return false;
    }
  }
  return true;
}

function collectFollowingToolResults(
  messages: AgentMessage[],
  index: number,
): { ids: Set<string>; displaced: boolean } {
  const ids = new Set<string>();
  let sawNonToolResult = false;
  let displaced = false;
  for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
    const message = messages[nextIndex];
    if (!message || typeof message !== "object") {
      sawNonToolResult = true;
      continue;
    }
    if (message.role === "assistant" && assistantTurnHasReplayToolCall(message)) {
      break;
    }
    if (message.role === "toolResult") {
      const resultIds = extractToolResultIds(message);
      for (const id of resultIds) {
        ids.add(id);
      }
      displaced ||= resultIds.length > 0 && sawNonToolResult;
      continue;
    }
    sawNonToolResult = true;
  }
  return { ids, displaced };
}

function resolveReplayToolCallName(
  rawName: string,
  rawId: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (rawName.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS * 2) {
    return null;
  }
  const normalized = resolveToolCallName(rawName, allowedToolNames, rawId, true);
  if (!normalized) {
    return null;
  }
  const trimmed = normalized.trim();
  if (!trimmed || trimmed.length > REPLAY_TOOL_CALL_NAME_MAX_CHARS || /\s/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function sanitizeReplayToolCallInputs(
  messages: AgentMessage[],
  allowedToolNames?: Set<string>,
  allowProviderOwnedThinkingReplay?: boolean,
): ReplayToolCallSanitizeReport {
  let changed = false;
  let droppedAssistantMessages = 0;
  const out: AgentMessage[] = [];
  const preservedThinkingToolCallIds = new Set<string>();
  const priorToolCallIds = new Set<string>();
  const isCompleted = createCompletedToolCallPredicate(messages);

  for (const [index, message] of messages.entries()) {
    if (!message) {
      changed = true;
      continue;
    }
    if (
      typeof message !== "object" ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      out.push(message);
      continue;
    }
    if (allowProviderOwnedThinkingReplay && isSignedThinkingReplayAssistantSpan(message)) {
      const replaySafeToolCalls = extractToolCallsFromAssistant(message);
      const followingToolResults = collectFollowingToolResults(messages, index);
      if (
        isReplaySafeThinkingTurn(message.content, allowedToolNames, isCompleted) &&
        replaySafeToolCalls.every(
          (toolCall) =>
            !preservedThinkingToolCallIds.has(toolCall.id) &&
            (!followingToolResults.displaced || !priorToolCallIds.has(toolCall.id)) &&
            followingToolResults.ids.has(toolCall.id),
        )
      ) {
        for (const toolCall of replaySafeToolCalls) {
          preservedThinkingToolCallIds.add(toolCall.id);
          priorToolCallIds.add(toolCall.id);
        }
        changed ||= followingToolResults.displaced;
        out.push(message);
      } else {
        changed = true;
        droppedAssistantMessages += 1;
      }
      continue;
    }

    const nextContent: typeof message.content = [];
    let messageChanged = false;

    for (const block of message.content) {
      if (!isRunnerToolCallBlock(block)) {
        nextContent.push(block);
        continue;
      }

      if (!hasToolCallInput(block) || !hasNonEmptyString(block.id)) {
        messageChanged = true;
        continue;
      }

      const rawName = typeof block.name === "string" ? block.name : "";
      const resolvedName = resolveReplayToolCallName(
        rawName,
        block.id,
        isCompleted(block) ? undefined : allowedToolNames,
      );
      if (!resolvedName) {
        messageChanged = true;
        continue;
      }

      messageChanged ||= block.name !== resolvedName;
      nextContent.push(block.name === resolvedName ? block : { ...block, name: resolvedName });
    }

    changed ||= messageChanged;
    if (nextContent.length === 0 && messageChanged) {
      droppedAssistantMessages += 1;
      continue;
    }
    const nextMessage = messageChanged
      ? replaceCompactionReplayOwnerContent(message, nextContent)
      : message;
    for (const toolCall of extractToolCallsFromAssistant(nextMessage)) {
      priorToolCallIds.add(toolCall.id);
    }
    out.push(nextMessage);
  }

  return {
    messages: changed ? out : messages,
    droppedAssistantMessages,
  };
}

function isSignedThinkingReplayAssistantSpan(message: AgentMessage | undefined): boolean {
  return assistantTurnHasReplayToolCall(message) && message.content.some(isThinkingLikeBlock);
}

function sanitizeAnthropicReplayToolResults(
  messages: AgentMessage[],
  options?: {
    disallowEmbeddedUserToolResultsForSignedThinkingReplay?: boolean;
  },
): AgentMessage[] {
  let changed = false;
  const out: AgentMessage[] = [];
  const disallowEmbeddedUserToolResultsForSignedThinkingReplay =
    options?.disallowEmbeddedUserToolResultsForSignedThinkingReplay === true;

  for (const [index, message] of messages.entries()) {
    if (!message) {
      changed = true;
      continue;
    }
    if (typeof message !== "object" || message.role !== "user" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }

    const previous = messages[index - 1];
    const shouldStripEmbeddedToolResults =
      disallowEmbeddedUserToolResultsForSignedThinkingReplay &&
      isSignedThinkingReplayAssistantSpan(previous);
    const validToolUseIds = new Set<string>();
    if (assistantTurnHasReplayToolCall(previous)) {
      for (const block of previous.content) {
        if (isRunnerToolCallBlock(block) && hasNonEmptyString(block.id)) {
          validToolUseIds.add(block.id.trim());
        }
      }
    }

    const nextContent = message.content.filter((block) => {
      const typedBlock = asOptionalObjectRecord(block);
      if (typedBlock?.type !== "toolResult" && typedBlock?.type !== "tool") {
        return true;
      }
      if (shouldStripEmbeddedToolResults) {
        changed = true;
        return false;
      }
      const resultIds = normalizeUniqueTrimmedStringList([
        typedBlock.toolUseId,
        typedBlock.toolCallId,
        typedBlock.tool_use_id,
        typedBlock.tool_call_id,
      ]);
      if (resultIds.length === 0) {
        changed = true;
        return false;
      }
      return validToolUseIds.size > 0 && resultIds.some((id) => validToolUseIds.has(id));
    });

    if (nextContent.length === message.content.length) {
      out.push(message);
      continue;
    }

    changed = true;
    out.push({
      ...message,
      content:
        nextContent.length > 0 ? nextContent : [{ type: "text", text: "[tool results omitted]" }],
    });
  }

  return changed ? out : messages;
}

function assistantTurnHasReplayToolCall(
  message: AgentMessage | undefined,
): message is Extract<AgentMessage, { role: "assistant" }> {
  if (!message || typeof message !== "object" || message.role !== "assistant") {
    return false;
  }
  return Array.isArray(message.content) && message.content.some(isRunnerToolCallBlock);
}

function stripTrailingAssistantPrefillTurns(messages: AgentMessage[]): AgentMessage[] {
  let end = messages.length;
  while (end > 0) {
    const message = messages[end - 1];
    if (
      !message ||
      typeof message !== "object" ||
      message.role !== "assistant" ||
      assistantTurnHasReplayToolCall(message)
    ) {
      break;
    }
    end -= 1;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

type ReplayToolCallIdSanitizerDecision = {
  sanitizeToolCallIds: boolean;
  toolCallIdMode?: ToolCallIdMode;
  isOpenAIResponsesApi: boolean;
};

export function shouldApplyReplayToolCallIdSanitizer(
  params: ReplayToolCallIdSanitizerDecision,
): params is ReplayToolCallIdSanitizerDecision & { toolCallIdMode: ToolCallIdMode } {
  return (
    params.sanitizeToolCallIds && Boolean(params.toolCallIdMode) && !params.isOpenAIResponsesApi
  );
}

export function sanitizeReplayToolCallIdsForStream(params: {
  messages: AgentMessage[];
  mode: ToolCallIdMode;
  allowedToolNames?: Set<string>;
  preserveNativeAnthropicToolUseIds?: boolean;
  duplicateToolCallIdStyle?: "openai";
  preserveReplaySafeThinkingToolCallIds?: boolean;
  repairToolUseResultPairing?: boolean;
}): AgentMessage[] {
  const paired = params.repairToolUseResultPairing
    ? sanitizeToolUseResultPairing(params.messages)
    : params.messages;
  return sanitizeToolCallIdsForCloudCodeAssist(paired, params.mode, {
    preserveNativeAnthropicToolUseIds: params.preserveNativeAnthropicToolUseIds,
    duplicateToolCallIdStyle: params.duplicateToolCallIdStyle,
    preserveReplaySafeThinkingToolCallIds: params.preserveReplaySafeThinkingToolCallIds,
    allowedToolNames: params.allowedToolNames,
  });
}

export function sanitizeOpenAIResponsesReplayForStream(messages: AgentMessage[]): AgentMessage[] {
  const repaired = sanitizeToolUseResultPairingForModel(messages, true);
  return downgradeOpenAIFunctionCallReasoningPairs(normalizeOpenAIResponsesToolCallIds(repaired));
}

export function wrapStreamFnSanitizeMalformedToolCalls(
  baseFn: StreamFn,
  allowedToolNames?: Set<string>,
  transcriptPolicy?: Pick<
    TranscriptPolicy,
    | "validateGeminiTurns"
    | "validateAnthropicTurns"
    | "preserveSignatures"
    | "dropThinkingBlocks"
    | "appendOnlyRuntimeContext"
  >,
  provider?: string | null,
): StreamFn {
  return (model, context, options) => {
    const messages = context?.messages;
    if (!Array.isArray(messages)) {
      return baseFn(model, context, options);
    }
    const modelApi = model.api;
    const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
      modelApi,
      provider,
      policy: {
        validateAnthropicTurns: transcriptPolicy?.validateAnthropicTurns === true,
        preserveSignatures: transcriptPolicy?.preserveSignatures === true,
        dropThinkingBlocks: transcriptPolicy?.dropThinkingBlocks === true,
      },
    });
    const sanitized = sanitizeReplayToolCallInputs(
      messages,
      allowedToolNames,
      allowProviderOwnedThinkingReplay,
    );
    const isOpenAIResponsesApi =
      modelApi === "openai-responses" ||
      modelApi === "openai-chatgpt-responses" ||
      modelApi === "azure-openai-responses";
    const replayInputsChanged = sanitized.messages !== messages;
    let nextMessages = isOpenAIResponsesApi
      ? sanitizeToolUseResultPairingForModel(sanitized.messages, true)
      : replayInputsChanged
        ? sanitizeToolUseResultPairing(sanitized.messages)
        : sanitized.messages;
    let strippedTrailingAssistantPrefill = false;
    if (transcriptPolicy?.validateAnthropicTurns) {
      nextMessages = sanitizeAnthropicReplayToolResults(nextMessages, {
        disallowEmbeddedUserToolResultsForSignedThinkingReplay: allowProviderOwnedThinkingReplay,
      });
    }
    if (transcriptPolicy?.validateAnthropicTurns || transcriptPolicy?.validateGeminiTurns) {
      const beforeStrip = nextMessages;
      nextMessages = stripTrailingAssistantPrefillTurns(nextMessages);
      strippedTrailingAssistantPrefill ||= nextMessages !== beforeStrip;
    }
    // Appended Bedrock users need merging without revalidating unchanged signed tools.
    if (nextMessages === messages) {
      if (modelApi !== "bedrock-converse-stream") {
        return baseFn(model, context, options);
      }
      nextMessages = mergeConsecutiveUserMessages(nextMessages);
    } else if (
      sanitized.droppedAssistantMessages > 0 ||
      transcriptPolicy?.validateAnthropicTurns ||
      strippedTrailingAssistantPrefill
    ) {
      if (transcriptPolicy?.validateGeminiTurns) {
        nextMessages = validateGeminiTurns(nextMessages);
      }
      if (transcriptPolicy?.validateAnthropicTurns) {
        nextMessages = validateAnthropicTurns(nextMessages, {
          mergeConsecutiveUserTurns: shouldMergeConsecutiveUserTurns(transcriptPolicy, modelApi),
        });
      }
    }
    if (nextMessages === messages) {
      return baseFn(model, context, options);
    }
    return baseFn(model, { ...context, messages: nextMessages as typeof messages }, options);
  };
}
