import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "@openclaw/llm-core/types";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import {
  classifyToolPairingFacts,
  resolveLegacyToolResultId,
  selectResetKeptMessageFacts,
  type ToolCallLike,
  type ToolPairingMessageFact,
} from "./tool-pairing-facts.js";

export { createToolCallOccurrenceQueue } from "./tool-pairing-facts.js";

const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);
export const SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY = "openclawSyntheticMissingToolResult";
export const LEGACY_MISSING_TOOL_RESULT_TEXT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";

type ToolCallOccurrence = {
  contentIndex: number;
  id: string;
  name?: string;
  result?: ToolResultMessage;
  sourceResult?: ToolResultMessage;
  sourceResultIndex?: number;
};

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

type ToolResultIdAliases = {
  toolCallId?: unknown;
  toolUseId?: unknown;
  tool_call_id?: unknown;
  tool_use_id?: unknown;
  callId?: unknown;
  call_id?: unknown;
};

type ToolUsePairingFrame = {
  startIndex: number;
  endIndex: number;
  assistant: Extract<AgentMessage, { role: "assistant" }>;
  remainder: AgentMessage[];
  occurrences: ToolCallOccurrence[];
  failed: boolean;
};

function readToolCall(block: unknown): ToolCallLike | undefined {
  const record = asOptionalObjectRecord(block);
  if (
    typeof record?.type !== "string" ||
    !TOOL_CALL_TYPES.has(record.type) ||
    typeof record.id !== "string" ||
    !record.id
  ) {
    return undefined;
  }
  return { id: record.id, name: typeof record.name === "string" ? record.name : undefined };
}

export function extractToolCallsFromAssistant(
  message: Extract<AgentMessage, { role: "assistant" }>,
): ToolCallLike[] {
  return Array.isArray(message.content)
    ? message.content.flatMap((block) => readToolCall(block) ?? [])
    : [];
}

export function extractToolResultIds(message: ToolResultMessage): string[] {
  const record: ToolResultIdAliases = message;
  return normalizeUniqueTrimmedStringList([
    record.toolCallId,
    record.toolUseId,
    record.tool_call_id,
    record.tool_use_id,
    record.callId,
    record.call_id,
  ]);
}

export function extractToolResultId(message: ToolResultMessage): string | null {
  const record: ToolResultIdAliases = message;
  return (
    normalizeOptionalString(record.toolCallId) ??
    normalizeOptionalString(record.toolUseId) ??
    normalizeOptionalString(record.tool_call_id) ??
    normalizeOptionalString(record.tool_use_id) ??
    normalizeOptionalString(record.callId) ??
    normalizeOptionalString(record.call_id) ??
    null
  );
}

export function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
  text?: string;
  timestamp?: number;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [{ type: "text", text: params.text ?? DEFAULT_MISSING_TOOL_RESULT_TEXT }],
    details: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true, reason: "missing_tool_result" },
    isError: true,
    timestamp: params.timestamp ?? Date.now(),
  };
}

export function isSyntheticMissingToolResult(message: {
  isError?: unknown;
  details?: unknown;
  content?: unknown;
}): boolean {
  if (!message.isError) {
    return false;
  }
  if (
    asOptionalObjectRecord(message.details)?.[SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY] === true
  ) {
    return true;
  }
  const content = message.content;
  return (
    Array.isArray(content) &&
    content.some((block) => {
      const record = asOptionalObjectRecord(block);
      return record?.type === "text" && record.text === LEGACY_MISSING_TOOL_RESULT_TEXT;
    })
  );
}

function normalizeToolResultName(
  message: ToolResultMessage,
  fallbackName?: string,
): ToolResultMessage {
  const rawToolName = message.toolName;
  const toolName =
    normalizeOptionalString(rawToolName) ??
    normalizeOptionalString(fallbackName) ??
    (typeof rawToolName === "string" ? "unknown" : undefined);
  return toolName && toolName !== rawToolName ? { ...message, toolName } : message;
}

export function normalizeLegacyToolResultId(
  message: ToolResultMessage,
  toolCalls: ToolCallLike[],
): ToolResultMessage {
  const id = extractToolResultId(message);
  const resolved = resolveLegacyToolResultId(id, message.toolName, toolCalls);
  return resolved !== null && resolved !== id ? { ...message, toolCallId: resolved } : message;
}

/** Adjacent, ordered results need no repair; reject extras that could replace earlier results. */
export function isToolUseResultPairingCanonical(messages: readonly AgentMessage[]): boolean {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || message.role === "toolResult") {
      return false;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      const call = readToolCall(block);
      if (!call) {
        continue;
      }
      const result = messages[++index];
      if (
        message.stopReason === "error" ||
        message.stopReason === "aborted" ||
        result?.role !== "toolResult" ||
        extractToolResultId(result) !== call.id ||
        normalizeToolResultName(result, call.name) !== result
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Collect ownership facts while a source row is decoded; never retain its content or details. */
export function collectToolPairingMessageFact(
  message: AgentMessage,
): ToolPairingMessageFact | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      id: extractToolResultId(message),
      name: message.toolName,
      synthetic: isSyntheticMissingToolResult(message),
    };
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return {
      role: "assistant",
      calls: message.content.flatMap((block, contentIndex) => {
        const call = readToolCall(block);
        return call ? [{ ...call, contentIndex }] : [];
      }),
      failed: message.stopReason === "error" || message.stopReason === "aborted",
    };
  }
  return { role: "other" };
}

/** Classifies call/result ownership without reordering or synthesizing transcript messages. */
export function classifyToolUseResultPairing(
  messages: readonly AgentMessage[],
  options?: { preserveUnframedToolResults?: boolean },
): ToolUsePairingFrame[] {
  const frames = classifyToolPairingFacts(messages.map(collectToolPairingMessageFact), options);
  const readResult = (index: number, id: string | null) => {
    const source = messages[index];
    if (source?.role !== "toolResult") {
      throw new Error("Tool pairing result does not reference a tool result");
    }
    return {
      source,
      normalized: id && id !== extractToolResultId(source) ? { ...source, toolCallId: id } : source,
    };
  };
  return frames.map((frame) => {
    const assistant = messages[frame.startIndex];
    if (assistant?.role !== "assistant") {
      throw new Error("Tool pairing frame does not reference an assistant");
    }
    return {
      startIndex: frame.startIndex,
      endIndex: frame.endIndex,
      assistant,
      failed: frame.failed,
      remainder: frame.remainder.flatMap(({ index, id }) => {
        const message = messages[index];
        return message ? [id !== undefined ? readResult(index, id).normalized : message] : [];
      }),
      occurrences: frame.occurrences.map(({ result, ...occurrence }) => {
        if (!result) {
          return occurrence;
        }
        const { source, normalized } = readResult(result.index, result.id);
        return {
          ...occurrence,
          result: normalizeToolResultName(normalized, occurrence.name),
          sourceResult: source,
          sourceResultIndex: result.index,
        };
      }),
    };
  });
}

/** Select actual completed occurrences, never unmatched calls or synthesized missing results. */
export function collectCompletedToolCallBlocks(
  messages: readonly AgentMessage[],
  frames = classifyToolUseResultPairing(messages),
): Set<object> {
  const completed = new Set<object>();
  for (const frame of frames) {
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResult && !isSyntheticMissingToolResult(occurrence.sourceResult)) {
        const block = frame.assistant.content[occurrence.contentIndex];
        if (block && typeof block === "object") {
          completed.add(block);
        }
      }
    }
  }
  return completed;
}

/** Select reset-tail model context without changing persisted entry bytes or order. */
export function selectResetKeptEntries(entries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
  return selectResetKeptMessageFacts(
    entries.flatMap((entry) =>
      entry.type === "message"
        ? [
            {
              entry,
              role: entry.message.role,
              pairing: collectToolPairingMessageFact(entry.message),
              identity: entry.message,
            },
          ]
        : [],
    ),
  ).map(({ entry }) => entry);
}
