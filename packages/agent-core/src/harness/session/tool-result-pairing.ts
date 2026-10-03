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

type ToolUsePairingClassification = {
  frames: ToolUsePairingFrame[];
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
  droppedResults: Array<{ message: ToolResultMessage; index: number }>;
};

type ToolCallOccurrenceQueue<T> = {
  add: (id: string, occurrence: T) => void;
  claim: (id: string) => T | undefined;
  clear: () => void;
  readonly size: number;
};

/** Tracks repeated provider ids by occurrence instead of collapsing them into a set. */
export function createToolCallOccurrenceQueue<T>(): ToolCallOccurrenceQueue<T> {
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
  const record = message as {
    toolCallId?: unknown;
    toolUseId?: unknown;
    tool_call_id?: unknown;
    tool_use_id?: unknown;
    callId?: unknown;
    call_id?: unknown;
  };
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
  return extractToolResultIds(message)[0] ?? null;
}

export function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
  text?: string;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [{ type: "text", text: params.text ?? DEFAULT_MISSING_TOOL_RESULT_TEXT }],
    details: { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true, reason: "missing_tool_result" },
    isError: true,
    timestamp: Date.now(),
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
  return { ...message, toolCallId: toolCall.id, isError: true };
}

/** Classifies call/result ownership without reordering or synthesizing transcript messages. */
export function classifyToolUseResultPairing(
  messages: readonly AgentMessage[],
  options?: { preserveUnframedToolResults?: boolean },
): ToolUsePairingClassification {
  const frameStartIndexes = messages.flatMap((message, index) =>
    message?.role === "assistant" && extractToolCallsFromAssistant(message).length > 0
      ? [index]
      : [],
  );
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  const droppedResults: Array<{ message: ToolResultMessage; index: number }> = [];
  const preserveUnframed = options?.preserveUnframedToolResults === true;
  const frameRecords: Array<ToolUsePairingFrame & { unclaimedResults: ToolResultRecord[] }> =
    frameStartIndexes.map((startIndex, frameIndex) => {
      const assistant = messages[startIndex] as Extract<AgentMessage, { role: "assistant" }>;
      const toolCalls: ToolCallLike[] = [];
      const occurrences: ToolCallOccurrence[] = [];
      const pending = createToolCallOccurrenceQueue<ToolCallOccurrence>();
      const syntheticById = createToolCallOccurrenceQueue<ToolCallOccurrence>();
      for (const [contentIndex, block] of assistant.content.entries()) {
        const toolCall = readToolCall(block);
        if (!toolCall) {
          continue;
        }
        toolCalls.push(toolCall);
        const occurrence = { ...toolCall, contentIndex };
        occurrences.push(occurrence);
        pending.add(toolCall.id, occurrence);
      }
      const endIndex = frameStartIndexes[frameIndex + 1] ?? messages.length;
      const remainder: AgentMessage[] = [];
      const unclaimedResults: ToolResultRecord[] = [];
      for (let index = startIndex + 1; index < endIndex; index += 1) {
        const message = messages[index];
        if (!message || typeof message !== "object") {
          continue;
        }
        if (message.role !== "toolResult") {
          remainder.push(message);
          continue;
        }
        const normalized = normalizeLegacyToolResultId(message, toolCalls);
        const id = extractToolResultId(normalized);
        const occurrence = id ? pending.claim(id) : undefined;
        if (occurrence) {
          occurrence.result = normalizeToolResultName(normalized, occurrence.name);
          occurrence.sourceResult = message;
          occurrence.sourceResultIndex = index;
          if (isSyntheticMissingToolResult(occurrence.result)) {
            syntheticById.add(occurrence.id, occurrence);
          }
          continue;
        }
        if (!id || !occurrences.some((candidate) => candidate.id === id)) {
          unclaimedResults.push({
            result: normalized,
            sourceResult: message,
            index,
            id: id ?? undefined,
          });
          if (preserveUnframed) {
            remainder.push(normalized);
          }
          continue;
        }
        droppedDuplicateCount += 1;
        const replaceable = isSyntheticMissingToolResult(normalized)
          ? undefined
          : syntheticById.claim(id);
        if (replaceable) {
          const discardedSource = replaceable.sourceResult;
          if (discardedSource) {
            droppedResults.push({
              message: discardedSource,
              index: replaceable.sourceResultIndex ?? index,
            });
          }
          replaceable.result = normalizeToolResultName(normalized, replaceable.name);
          replaceable.sourceResult = message;
          replaceable.sourceResultIndex = index;
        } else {
          droppedResults.push({ message, index });
        }
      }
      const stopReason = (assistant as { stopReason?: string }).stopReason;
      return {
        startIndex,
        endIndex,
        assistant,
        remainder,
        unclaimedResults,
        occurrences,
        failed: stopReason === "error" || stopReason === "aborted",
      };
    });

  // Displaced results cross a frame only when one unresolved occurrence can own them.
  const unresolvedById = new Map<string, ToolCallOccurrence[]>();
  for (const frame of frameRecords) {
    for (const occurrence of frame.occurrences) {
      if (!occurrence.result || isSyntheticMissingToolResult(occurrence.result)) {
        const unresolved = unresolvedById.get(occurrence.id);
        if (unresolved) {
          unresolved.push(occurrence);
        } else {
          unresolvedById.set(occurrence.id, [occurrence]);
        }
      }
    }
    for (const record of frame.unclaimedResults) {
      const candidates = record.id
        ? (unresolvedById.get(record.id) ?? []).filter(
            (candidate) =>
              !candidate.result ||
              (isSyntheticMissingToolResult(candidate.result) &&
                !isSyntheticMissingToolResult(record.result)),
          )
        : [];
      if (candidates.length !== 1) {
        droppedOrphanCount += preserveUnframed ? 0 : 1;
        if (!preserveUnframed) {
          droppedResults.push({ message: record.sourceResult, index: record.index });
        }
        continue;
      }
      const candidate = candidates[0];
      if (!candidate) {
        continue;
      }
      droppedDuplicateCount += candidate.result ? 1 : 0;
      if (candidate.result && isSyntheticMissingToolResult(candidate.result)) {
        const discardedSource = candidate.sourceResult;
        if (discardedSource) {
          droppedResults.push({
            message: discardedSource,
            index: candidate.sourceResultIndex ?? record.index,
          });
        }
      }
      candidate.result = normalizeToolResultName(record.result, candidate.name);
      candidate.sourceResult = record.sourceResult;
      candidate.sourceResultIndex = record.index;
      if (preserveUnframed) {
        frame.remainder = frame.remainder.filter((message) => message !== record.result);
      }
    }
  }

  return { frames: frameRecords, droppedDuplicateCount, droppedOrphanCount, droppedResults };
}

/** Select actual completed occurrences, never unmatched calls or synthesized missing results. */
export function collectCompletedToolCallBlocks(messages: readonly AgentMessage[]): Set<object> {
  const completed = new Set<object>();
  for (const frame of classifyToolUseResultPairing(messages).frames) {
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
  const pairing = classifyToolUseResultPairing(messages);
  const pairedResults = new Set(
    pairing.frames.flatMap((frame) =>
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
