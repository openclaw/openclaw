import type { AgentMessage } from "@openclaw/agent-core";
import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
/**
 * Transcript repair helpers for tool-call replay.
 *
 * Normalizes raw tool-call blocks and synthesizes missing tool results without rewriting trusted local payloads.
 */
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import {
  classifyToolUseResultPairing,
  makeMissingToolResult,
  normalizeLegacyToolResultId,
} from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  collectToolCallIds,
  isContractToolCallBlock,
  type ToolCallBlock,
} from "../shared/tool-block-contract.js";
import { isThinkingLikeBlock } from "./thinking-block.js";
import {
  extractToolCallsFromAssistant,
  extractToolResultIds,
  hasToolCallInput,
} from "./tool-call-id.js";
import {
  createCompletedToolCallPredicate,
  isAllowedToolCallName,
  normalizeAllowedToolNames,
} from "./tool-call-shared.js";

type RawToolCallBlock = ToolCallBlock & {
  partialJson?: unknown;
};

function hasToolCallId(block: RawToolCallBlock): boolean {
  return collectToolCallIds(block).length > 0;
}

function hasPartialJson(
  block: RawToolCallBlock,
): block is RawToolCallBlock & { partialJson: string } {
  return typeof block.partialJson === "string";
}

function isCompleteJsonObject(value: string): boolean {
  return safeParseJsonRecord(value) !== undefined;
}

function isFinalizedOpenAIResponsesToolCall(
  message: AgentMessage,
  block: RawToolCallBlock,
): boolean {
  if (
    message.role !== "assistant" ||
    !("stopReason" in message) ||
    message.stopReason !== "toolUse" ||
    !hasPartialJson(block) ||
    typeof block.id !== "string" ||
    "input" in block ||
    !block.arguments ||
    typeof block.arguments !== "object" ||
    Array.isArray(block.arguments) ||
    (!isCompleteJsonObject(block.partialJson) &&
      (block.partialJson.trim() !== "" || Object.keys(block.arguments).length > 0))
  ) {
    return false;
  }

  const separator = block.id.indexOf("|");
  return separator > 0 && separator < block.id.length - 1;
}

function sanitizeToolCallBlock(block: RawToolCallBlock): RawToolCallBlock {
  // This repair path normalizes replay shape only. Tool payloads are local
  // trusted-operator transcript state per SECURITY.md, so do not redact or
  // rewrite sessions_spawn arguments here.
  const rawName = readStringValue(block.name);
  const name = rawName?.trim();
  return name && name !== rawName ? { ...block, name } : block;
}

function isReplaySafeThinkingAssistantTurn(
  content: unknown[],
  allowedToolNames: Set<string> | null,
  isCompleted: ReturnType<typeof createCompletedToolCallPredicate>,
): boolean {
  let sawToolCall = false;
  const seenToolCallIds = new Set<string>();
  for (const block of content) {
    if (!isContractToolCallBlock(block)) {
      continue;
    }
    sawToolCall = true;
    const toolCallId = typeof block.id === "string" ? block.id.trim() : "";
    if (
      !hasToolCallInput(block) ||
      hasPartialJson(block) ||
      !toolCallId ||
      seenToolCallIds.has(toolCallId) ||
      !isAllowedToolCallName(block.name, isCompleted(block) ? null : allowedToolNames)
    ) {
      return false;
    }
    seenToolCallIds.add(toolCallId);
    if (sanitizeToolCallBlock(block) !== block) {
      return false;
    }
  }
  return sawToolCall;
}

function hasSessionsSpawnAttachmentToolCall(content: unknown[]): boolean {
  for (const block of content) {
    if (!isContractToolCallBlock(block) || block.name !== "sessions_spawn") {
      continue;
    }
    const input = block.input;
    if (!input || typeof input !== "object") {
      continue;
    }
    const attachments = (input as { attachments?: unknown }).attachments;
    if (Array.isArray(attachments) && attachments.length > 0) {
      return true;
    }
  }
  return false;
}

export { makeMissingToolResult };

type ToolCallInputRepairOptions = {
  allowedToolNames?: Iterable<string>;
  allowProviderOwnedThinkingReplay?: boolean;
};

type ErroredAssistantResultPolicy = "preserve" | "drop";

type ToolUseResultPairingOptions = {
  erroredAssistantResultPolicy?: ErroredAssistantResultPolicy;
  missingToolResultText?: string;
  // A valid Responses checkpoint may split a call from its later output.
  // Only that replay owner may retain results that normal repair treats as orphaned.
  preserveUnframedToolResults?: boolean;
};

export { stripToolResultDetails } from "../shared/model-context-message.js";

function collectFollowingToolResults(
  messages: AgentMessage[],
  index: number,
): { ids: Set<string>; displaced: boolean } {
  const ids = new Set<string>();
  const assistant = messages[index];
  const currentToolCalls =
    assistant && typeof assistant === "object" && assistant.role === "assistant"
      ? extractToolCallsFromAssistant(assistant)
      : [];
  let sawNonToolResult = false;
  let displaced = false;
  for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
    const message = messages[nextIndex];
    if (!message || typeof message !== "object") {
      sawNonToolResult = true;
      continue;
    }
    if (message.role === "assistant" && extractToolCallsFromAssistant(message).length > 0) {
      break;
    }
    if (message.role === "toolResult") {
      const normalizedLegacyResult = normalizeLegacyToolResultId(message, currentToolCalls);
      const resultIds = extractToolResultIds(normalizedLegacyResult);
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

export function sanitizeToolCallInputs(
  messages: AgentMessage[],
  options?: ToolCallInputRepairOptions,
): AgentMessage[] {
  let changed = false;
  const out: AgentMessage[] = [];
  const allowedToolNames = normalizeAllowedToolNames(options?.allowedToolNames);
  const isCompleted = createCompletedToolCallPredicate(messages);
  const allowProviderOwnedThinkingReplay = options?.allowProviderOwnedThinkingReplay === true;
  const preservedThinkingToolCallIds = new Set<string>();
  const priorToolCallIds = new Set<string>();

  for (const [index, msg] of messages.entries()) {
    if (!msg || typeof msg !== "object") {
      changed = true;
      continue;
    }

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    if (
      allowProviderOwnedThinkingReplay &&
      msg.content.some((block) => isThinkingLikeBlock(block)) &&
      msg.content.some(isContractToolCallBlock)
    ) {
      // Signed Anthropic thinking blocks must remain byte-for-byte stable on
      // replay. Preserve the turn when every sibling tool call is already valid;
      // the later pairing repair can synthesize missing legacy tool results
      // without mutating provider-owned assistant content.
      const replaySafeToolCalls = extractToolCallsFromAssistant(msg);
      const followingToolResults = collectFollowingToolResults(messages, index);
      const hasSpawnAttachments = hasSessionsSpawnAttachmentToolCall(msg.content);
      if (
        isReplaySafeThinkingAssistantTurn(msg.content, allowedToolNames, isCompleted) &&
        replaySafeToolCalls.every(
          (toolCall) =>
            !preservedThinkingToolCallIds.has(toolCall.id) &&
            (!hasSpawnAttachments || followingToolResults.ids.has(toolCall.id)) &&
            (!followingToolResults.displaced || !priorToolCallIds.has(toolCall.id)),
        )
      ) {
        for (const toolCall of replaySafeToolCalls) {
          preservedThinkingToolCallIds.add(toolCall.id);
          priorToolCallIds.add(toolCall.id);
        }
        changed ||= followingToolResults.displaced;
        out.push(msg);
      } else {
        changed = true;
      }
      continue;
    }

    const nextContent: typeof msg.content = [];
    let messageChanged = false;

    for (const block of msg.content) {
      if (isContractToolCallBlock(block)) {
        const rawBlock = block as RawToolCallBlock;
        // Drop genuinely incomplete streaming artifacts (missing required fields).
        if (
          !hasToolCallInput(block) ||
          !hasToolCallId(block) ||
          !isAllowedToolCallName(rawBlock.name, isCompleted(rawBlock) ? null : allowedToolNames)
        ) {
          changed = true;
          messageChanged = true;
          continue;
        }
      }
      let workBlock = block;
      if (isContractToolCallBlock(block) && hasPartialJson(block)) {
        if (!isFinalizedOpenAIResponsesToolCall(msg, block)) {
          changed = true;
          messageChanged = true;
          continue;
        }

        // Legacy generic Responses transport persisted successful toolUse turns
        // with the scratch buffer intact. Strip it only when terminal state and
        // the provider-specific finalized shape both prove completion.
        const stripped = { ...block };
        delete (stripped as RawToolCallBlock & { partialJson?: unknown }).partialJson;
        workBlock = stripped;
        changed = true;
        messageChanged = true;
      }
      if (isContractToolCallBlock(workBlock)) {
        const sanitized = sanitizeToolCallBlock(workBlock);
        if (sanitized !== workBlock) {
          changed = true;
          messageChanged = true;
        }
        nextContent.push(sanitized as typeof block);
        continue;
      }
      nextContent.push(workBlock);
    }

    if (messageChanged && nextContent.length === 0) {
      continue;
    }
    const nextMessage = messageChanged
      ? replaceCompactionReplayOwnerContent(msg, nextContent)
      : msg;
    for (const toolCall of extractToolCallsFromAssistant(nextMessage)) {
      priorToolCallIds.add(toolCall.id);
    }
    out.push(nextMessage);
  }

  return changed ? out : messages;
}

export function sanitizeToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): AgentMessage[] {
  return repairToolUseResultPairing(messages, options).messages;
}

export function sanitizeToolUseResultPairingForModel(
  messages: AgentMessage[],
  isOpenAIResponsesApi: boolean,
): AgentMessage[] {
  return sanitizeToolUseResultPairing(messages, {
    erroredAssistantResultPolicy: "drop",
    // Match upstream Codex history normalization for OpenAI Responses.
    ...(isOpenAIResponsesApi ? { missingToolResultText: "aborted" } : {}),
  });
}

type ToolUseRepairReport = {
  messages: AgentMessage[];
  added: Array<Extract<AgentMessage, { role: "toolResult" }>>;
  discarded: AgentMessage[];
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
  moved: boolean;
};

export function repairToolUseResultPairing(
  messages: AgentMessage[],
  options?: ToolUseResultPairingOptions,
): ToolUseRepairReport {
  // Anthropic (and Cloud Code Assist) reject transcripts where assistant tool calls are not
  // immediately followed by matching tool results. Session files can end up with results
  // displaced (e.g. after user turns) or duplicated. Repair by:
  // - moving matching toolResult messages directly after their assistant toolCall turn
  // - inserting synthetic error toolResults for missing ids
  // - dropping duplicate toolResults for the same tool-call occurrence
  // Provider ids are opaque and can legitimately repeat on later assistant turns.
  const added: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  const preserveUnframed = options?.preserveUnframedToolResults === true;
  const pairing = classifyToolUseResultPairing(messages, {
    preserveUnframedToolResults: preserveUnframed,
  });
  const { frames } = pairing;
  const droppedDuplicateCount = pairing.droppedDuplicateCount;
  let droppedOrphanCount = pairing.droppedOrphanCount;
  const discarded: Array<{ message: AgentMessage; index: number }> = pairing.droppedResults.map(
    ({ message, index }) => ({ message, index }),
  );

  const out: AgentMessage[] = [];
  let cursor = 0;
  const pushUnframedRange = (endIndex: number) => {
    for (; cursor < endIndex; cursor += 1) {
      const sourceIndex = cursor;
      const message = messages[cursor];
      if (!message || typeof message !== "object") {
        continue;
      }
      if (message.role === "toolResult" && !preserveUnframed) {
        droppedOrphanCount += 1;
        discarded.push({ message, index: sourceIndex });
        continue;
      }
      out.push(message);
    }
  };

  for (const frame of frames) {
    pushUnframedRange(frame.startIndex);
    cursor = frame.endIndex;

    if (!(frame.failed && options?.erroredAssistantResultPolicy === "drop")) {
      out.push(frame.assistant);
      for (const occurrence of frame.occurrences) {
        if (occurrence.result) {
          out.push(occurrence.result);
          continue;
        }
        if (frame.failed) {
          continue;
        }
        const missing = makeMissingToolResult({
          toolCallId: occurrence.id,
          toolName: occurrence.name,
          text: options?.missingToolResultText,
        });
        occurrence.result = missing;
        added.push(missing);
        out.push(missing);
      }
    } else {
      for (const occurrence of frame.occurrences) {
        if (occurrence.sourceResult) {
          discarded.push({
            message: occurrence.sourceResult,
            index: occurrence.sourceResultIndex ?? messages.indexOf(occurrence.sourceResult),
          });
        }
      }
    }
    out.push(...frame.remainder);
  }
  pushUnframedRange(messages.length);

  const changed =
    out.length !== messages.length || out.some((message, index) => message !== messages[index]);
  discarded.sort((left, right) => left.index - right.index);
  return {
    messages: changed ? out : messages,
    added,
    discarded: discarded.map(({ message }) => message),
    droppedDuplicateCount,
    droppedOrphanCount,
    moved: changed,
  };
}
