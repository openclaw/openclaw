import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "@openclaw/llm-core/types";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";

const TOOL_CALL_TYPES = new Set(["toolCall", "toolUse", "functionCall"]);
export const SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY = "openclawSyntheticMissingToolResult";
export const LEGACY_MISSING_TOOL_RESULT_TEXT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";

type ToolCallLike = {
  id: string;
  name?: string;
};

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

type ToolResultRecord = {
  result: ToolResultMessage;
  sourceResult: ToolResultMessage;
  index: number;
  id?: string;
};

type ToolUsePairingFrame = {
  startIndex: number;
  endIndex: number;
  assistant: Extract<AgentMessage, { role: "assistant" }>;
  remainder: AgentMessage[];
  occurrences: ToolCallOccurrence[];
  failed: boolean;
};

/** Tracks repeated provider ids by occurrence instead of collapsing them into a set. */
export function createToolCallOccurrenceQueue<T>(): {
  add: (id: string, occurrence: T) => void;
  claim: (id: string) => T | undefined;
  clear: () => void;
  readonly size: number;
} {
  const pendingById = new Map<string, T[]>();
  let pendingCount = 0;
  return {
    add(id, occurrence) {
      const pending = pendingById.get(id);
      if (pending) {
        pending.push(occurrence);
      } else {
        pendingById.set(id, [occurrence]);
      }
      pendingCount += 1;
    },
    claim(id) {
      const pending = pendingById.get(id);
      const occurrence = pending?.shift();
      if (!occurrence) {
        return undefined;
      }
      pendingCount -= 1;
      if (pending?.length === 0) {
        pendingById.delete(id);
      }
      return occurrence;
    },
    clear() {
      pendingById.clear();
      pendingCount = 0;
    },
    get size() {
      return pendingCount;
    },
  };
}

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
  if (extractToolResultId(message) || toolCalls.length !== 1) {
    return message;
  }
  const toolCall = toolCalls[0];
  if (!toolCall) {
    return message;
  }
  const resultName = normalizeOptionalString(message.toolName);
  const callName = normalizeOptionalString(toolCall.name);
  if (resultName && callName && resultName !== callName) {
    return message;
  }
  return { ...message, toolCallId: toolCall.id };
}

/** Classifies call/result ownership without reordering or synthesizing transcript messages. */
export function classifyToolUseResultPairing(
  messages: readonly AgentMessage[],
  options?: { preserveUnframedToolResults?: boolean },
): ToolUsePairingFrame[] {
  const preserveUnframed = options?.preserveUnframedToolResults === true;
  const frameRecords: Array<ToolUsePairingFrame & { unclaimedResults?: ToolResultRecord[] }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
      continue;
    }
    let frame: (typeof frameRecords)[number] | undefined;
    for (let contentIndex = 0; contentIndex < assistant.content.length; contentIndex += 1) {
      const toolCall = readToolCall(assistant.content[contentIndex]);
      if (!toolCall) {
        continue;
      }
      if (!frame) {
        const previous = frameRecords[frameRecords.length - 1];
        if (previous) {
          previous.endIndex = index;
        }
        const stopReason = assistant.stopReason;
        frame = {
          startIndex: index,
          endIndex: messages.length,
          assistant,
          remainder: [],
          unclaimedResults: undefined,
          occurrences: [],
          failed: stopReason === "error" || stopReason === "aborted",
        };
        frameRecords.push(frame);
      }
      frame.occurrences.push({ ...toolCall, contentIndex });
    }
  }

  for (const frame of frameRecords) {
    const { occurrences } = frame;
    const pending = createToolCallOccurrenceQueue<ToolCallOccurrence>();
    for (const occurrence of occurrences) {
      pending.add(occurrence.id, occurrence);
    }
    for (let index = frame.startIndex + 1; index < frame.endIndex; index += 1) {
      const message = messages[index];
      if (!message || typeof message !== "object") {
        continue;
      }
      if (message.role !== "toolResult") {
        frame.remainder.push(message);
        continue;
      }
      const normalized = normalizeLegacyToolResultId(message, occurrences);
      const id = extractToolResultId(normalized);
      const occurrence = id ? pending.claim(id) : undefined;
      if (occurrence) {
        occurrence.result = normalizeToolResultName(normalized, occurrence.name);
        occurrence.sourceResult = message;
        occurrence.sourceResultIndex = index;
        continue;
      }
      if (!id || !occurrences.some((candidate) => candidate.id === id)) {
        (frame.unclaimedResults ??= []).push({
          result: normalized,
          sourceResult: message,
          index,
          id: id ?? undefined,
        });
        if (preserveUnframed) {
          frame.remainder.push(normalized);
        }
        continue;
      }
      const replaceable = isSyntheticMissingToolResult(normalized)
        ? undefined
        : occurrences.find(
            (candidate) =>
              candidate.id === id &&
              candidate.result &&
              isSyntheticMissingToolResult(candidate.result),
          );
      if (replaceable) {
        replaceable.result = normalizeToolResultName(normalized, replaceable.name);
        replaceable.sourceResult = message;
        replaceable.sourceResultIndex = index;
      }
    }
  }

  // Displaced results cross a frame only when one unresolved occurrence can own them.
  let unresolvedById: Map<string, ToolCallOccurrence[]> | undefined;
  for (const frame of frameRecords) {
    for (const occurrence of frame.occurrences) {
      if (!occurrence.result || isSyntheticMissingToolResult(occurrence.result)) {
        unresolvedById ??= new Map();
        const unresolved = unresolvedById.get(occurrence.id);
        if (unresolved) {
          unresolved.push(occurrence);
        } else {
          unresolvedById.set(occurrence.id, [occurrence]);
        }
      }
    }
    if (!frame.unclaimedResults) {
      continue;
    }
    for (const record of frame.unclaimedResults) {
      const candidates = record.id
        ? unresolvedById
            ?.get(record.id)
            ?.filter(
              (candidate) =>
                !candidate.result ||
                (isSyntheticMissingToolResult(candidate.result) &&
                  !isSyntheticMissingToolResult(record.result)),
            )
        : undefined;
      const candidate = candidates?.length === 1 ? candidates[0] : undefined;
      if (!candidate) {
        continue;
      }
      candidate.result = normalizeToolResultName(record.result, candidate.name);
      candidate.sourceResult = record.sourceResult;
      candidate.sourceResultIndex = record.index;
      if (preserveUnframed) {
        frame.remainder = frame.remainder.filter((message) => message !== record.result);
      }
    }
  }

  return frameRecords;
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
  const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const frames = classifyToolUseResultPairing(messages);
  const pairedResults = new Set(
    frames.flatMap((frame) =>
      frame.occurrences.flatMap((occurrence) =>
        occurrence.sourceResult ? [occurrence.sourceResult] : [],
      ),
    ),
  );
  return entries.filter(
    (entry) =>
      entry.type === "message" &&
      (entry.message.role === "user" ||
        entry.message.role === "assistant" ||
        (entry.message.role === "toolResult" && pairedResults.has(entry.message))),
  );
}
