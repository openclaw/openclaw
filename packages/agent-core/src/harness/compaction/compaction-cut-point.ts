import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import type { AgentMessage } from "../../types.js";
import { isRuntimeContextCarrier } from "../messages.js";
import { projectSessionEntryMessage } from "../session/session.js";
import {
  classifyToolUseResultPairing,
  extractToolCallsFromAssistant,
} from "../session/tool-result-pairing.js";
import type { SessionTreeEntry } from "../types.js";
import {
  formatPersistedSenderSuffix,
  getCompactionContent,
  stringifyCompactionValue,
} from "./utils.js";

export function getMessageFromEntryForCompaction(
  entry: SessionTreeEntry,
): AgentMessage | undefined {
  if (entry.type === "compaction") {
    return undefined;
  }
  return projectSessionEntryMessage(entry);
}

export const IMAGE_BLOCK_TOKENS = 2_000;
const IMAGE_BLOCK_CHARS = IMAGE_BLOCK_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

function countContentChars(
  content: string | Array<{ type: string; content?: unknown; text?: string }>,
): number {
  const { text, omissionText } = getCompactionContent(content);
  const images =
    typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length;
  // Charge the largest role/separator even for mixed text. Any suppressed message's
  // minimum 56-character charge also covers the serializer's single 55-character overflow.
  const omissionChars = omissionText ? omissionText.length + "\n\n[Tool result]: ".length : 0;
  return estimateStringChars(text) + images * IMAGE_BLOCK_CHARS + omissionChars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
  if ("excludeFromContext" in message && message.excludeFromContext === true) {
    return 0;
  }
  let chars = 0;

  switch (message.role) {
    case "assistant": {
      for (const block of message.content) {
        if (block.type === "text") {
          chars += estimateStringChars(block.text);
        } else if (block.type === "thinking") {
          chars += estimateStringChars(block.thinking);
        } else if (block.type === "toolCall") {
          chars +=
            estimateStringChars(block.name) +
            estimateStringChars(stringifyCompactionValue(block.arguments));
        }
      }
      break;
    }
    case "user": {
      chars = countContentChars(message.content);
      // serializeConversation projects this exact persisted-sender suffix.
      chars += estimateStringChars(formatPersistedSenderSuffix(message));
      break;
    }
    case "custom":
    case "toolResult": {
      chars = countContentChars(message.content);
      break;
    }
    case "bashExecution": {
      chars = estimateStringChars(message.command) + estimateStringChars(message.output);
      break;
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = estimateStringChars(message.summary);
      break;
    }
  }

  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}
function isCutPointMessage(message: AgentMessage): boolean {
  return message.role === "assistant" || isTurnStartMessage(message);
}

function isTurnStartMessage(message: AgentMessage): boolean {
  const role = message.role;
  return role === "custom"
    ? !isRuntimeContextCarrier(message)
    : role === "user" ||
        role === "bashExecution" ||
        role === "branchSummary" ||
        role === "compactionSummary";
}

function isTurnStartEntry(entry: SessionTreeEntry): boolean {
  const message = getMessageFromEntryForCompaction(entry);
  return message ? isTurnStartMessage(message) : false;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(
  entries: SessionTreeEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry && isTurnStartEntry(entry)) {
      return i;
    }
  }
  return -1;
}

/** Cut point selected for compaction. */
interface CutPointResult {
  /** Index of the first entry retained after compaction. */
  firstKeptEntryIndex: number;
  /** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
  turnStartIndex: number;
  /** Whether the selected cut point splits an in-progress turn. */
  isSplitTurn: boolean;
}

/** Automatic callers supply the remaining foreground budget and its message estimator. */
interface CompactionRetentionBudget {
  maxTokens: number;
  reserveTokens: number;
  estimateTokens: (message: AgentMessage) => number;
}

export interface CompactionRetentionConstraints {
  /** An admitted, unprocessed user remains intact even before its budget is prepared. */
  preserveFromEntryId?: string;
  budget?: CompactionRetentionBudget;
}

function createToolPairCutResolver(messages: AgentMessage[], entryIndexes: number[]) {
  const ranges: Array<{ start: number; end: number }> = [];
  const entryIndexAt = (messageIndex: number): number => {
    const entryIndex = entryIndexes[messageIndex];
    if (entryIndex === undefined) {
      throw new Error("Tool pairing references a message outside the compaction entries");
    }
    return entryIndex;
  };
  for (const frame of classifyToolUseResultPairing(messages).frames) {
    const start = entryIndexAt(frame.startIndex);
    let end = start;
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResultIndex !== undefined) {
        end = Math.max(end, entryIndexAt(occurrence.sourceResultIndex));
      }
    }
    if (end === start) {
      continue;
    }
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  // A result can arrive after another assistant fragment or tool batch. Keep
  // its actual owning occurrence on the same side of the compaction boundary.
  return (index: number): number => {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = ranges[middle];
      if (!candidate) {
        throw new Error("Compaction tool range is missing from the selected search interval");
      }
      if (candidate.start < index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const range = ranges[low - 1];
    return range && index <= range.end ? range.start : index;
  };
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
  entries: SessionTreeEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
  constraints?: CompactionRetentionConstraints,
): CutPointResult {
  const retention = constraints?.budget;
  // Projection validates persisted custom/branch timestamps even outside the
  // retained tail. Keep that eager validation without storing every cut point.
  let cutIndex: number | undefined;
  let lastAllowedCut = endIndex - 1;
  const toolMessages: AgentMessage[] = [];
  const toolEntryIndexes: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    const message = entry ? getMessageFromEntryForCompaction(entry) : undefined;
    if (entry && entry.id === constraints?.preserveFromEntryId) {
      lastAllowedCut = i;
    }
    if (message && isCutPointMessage(message)) {
      cutIndex = i;
    }
    if (
      message?.role === "toolResult" ||
      (message?.role === "assistant" && extractToolCallsFromAssistant(message).length > 0)
    ) {
      toolMessages.push(message);
      toolEntryIndexes.push(i);
    }
  }
  if (cutIndex === undefined) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  const resolveCutPoint = createToolPairCutResolver(toolMessages, toolEntryIndexes);
  cutIndex = resolveCutPoint(cutIndex);
  lastAllowedCut = resolveCutPoint(lastAllowedCut);
  let accumulatedTokens = 0;

  // The latest valid cut also handles an oversized trailing tool result that
  // exhausts the budget before the reverse walk reaches its preceding boundary.
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const message = getMessageFromEntryForCompaction(entry);
    if (!message) {
      continue;
    }
    if (isCutPointMessage(message)) {
      cutIndex = resolveCutPoint(i);
    }
    accumulatedTokens += retention?.estimateTokens(message) ?? estimateTokens(message);
    if (accumulatedTokens >= keepRecentTokens) {
      break;
    }
  }
  cutIndex = Math.min(cutIndex, lastAllowedCut);
  if (retention) {
    let retainedTokens = 0;
    let fittingCut = endIndex;
    let tailLimit = retention.maxTokens;
    for (let i = endIndex - 1; i >= cutIndex; i--) {
      const entry = entries[i];
      const message = entry ? getMessageFromEntryForCompaction(entry) : undefined;
      retainedTokens += message ? retention.estimateTokens(message) : 0;
      if (retainedTokens > tailLimit) {
        break;
      }
      if (
        i <= lastAllowedCut &&
        message &&
        isCutPointMessage(message) &&
        resolveCutPoint(i) === i
      ) {
        if (fittingCut === endIndex) {
          // The summary maximum is a reservation, not a minimum: small windows
          // retain one complete atom and give the summary the remaining room.
          tailLimit = Math.max(retainedTokens, retention.maxTokens - retention.reserveTokens);
        }
        fittingCut = i;
      }
    }
    if (fittingCut === endIndex) {
      return { firstKeptEntryIndex: endIndex, turnStartIndex: -1, isSplitTurn: false };
    }
    cutIndex = fittingCut;
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (!prevEntry) {
      break;
    }
    if (prevEntry.type === "compaction" || prevEntry.type === "reset") {
      break;
    }
    // Metadata can follow the cut, but private persisted messages cannot become its boundary.
    if (prevEntry.type === "message" || getMessageFromEntryForCompaction(prevEntry)) {
      break;
    }
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  if (!cutEntry) {
    throw new Error("compaction cut point does not reference a session entry");
  }
  const startsTurn = isTurnStartEntry(cutEntry);
  const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}
