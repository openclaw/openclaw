import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import {
  buildSessionContext as buildCoreSessionContext,
  type AgentMessage,
  type SessionTreeEntry as CoreSessionTreeEntry,
} from "../runtime/index.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import type { ExtensionContext } from "../sessions/index.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";
import { formatContextMessage } from "./compaction-safeguard-messages.js";

const MAX_SPLIT_TURN_CONTEXT_CHARS = Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2);
const SPLIT_TURN_TRUNCATED_MARKER = "[Earlier split-turn messages truncated]\n";
const PRESERVED_TURNS_TRUNCATED_MARKER = "[Earlier preserved messages truncated]\n";
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const MAX_RECENT_TURNS_PRESERVE = 12;

export type ContextSection = {
  text: string;
  segmentStarts: number[];
  // Keep producer loss attached to the bounded artifact so every finalizer path
  // emits the same redacted diagnostic when the section already dropped context.
  truncatedLoss?: "split-turn-head" | "preserved-turn-head";
};

export function resolveRecentTurnsPreserve(value: number | undefined): number {
  return Math.min(
    MAX_RECENT_TURNS_PRESERVE,
    Math.max(0, Math.floor(value ?? DEFAULT_RECENT_TURNS_PRESERVE)),
  );
}

export function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summarizableMessages: AgentMessage[]; preservedMessages: AgentMessage[] } {
  const preserveTurns = params.recentTurnsPreserve;
  if (preserveTurns <= 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const conversationIndexes = params.messages.flatMap((message, index) =>
    message.role === "user" || message.role === "assistant" ? [index] : [],
  );
  if (conversationIndexes.length === 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }

  const userIndexes = conversationIndexes.filter(
    (index) => params.messages[index]?.role === "user",
  );
  const boundaryStartIndex = userIndexes.at(-preserveTurns);
  const preservedIndexSet = new Set(
    boundaryStartIndex === undefined
      ? userIndexes
      : conversationIndexes.filter((index) => index >= boundaryStartIndex),
  );
  if (boundaryStartIndex === undefined) {
    for (const index of conversationIndexes.toReversed()) {
      preservedIndexSet.add(index);
      if (preservedIndexSet.size >= preserveTurns * 2) {
        break;
      }
    }
  }
  const preservedToolCallIds = new Set<string>();
  for (const index of preservedIndexSet) {
    const message = params.messages[index];
    if (message?.role === "assistant") {
      for (const toolCall of extractToolCallsFromAssistant(message)) {
        preservedToolCallIds.add(toolCall.id);
      }
    }
  }
  if (preservedToolCallIds.size > 0) {
    const preservedStartIndex = conversationIndexes.find((index) => preservedIndexSet.has(index))!;
    for (let index = preservedStartIndex; index < params.messages.length; index += 1) {
      const message = params.messages[index];
      if (message?.role !== "toolResult") {
        continue;
      }
      const toolResultId = extractToolResultId(message);
      if (toolResultId && preservedToolCallIds.has(toolResultId)) {
        preservedIndexSet.add(index);
      }
    }
  }
  const summarizableMessages: AgentMessage[] = [];
  const preservedMessages: AgentMessage[] = [];
  for (const [index, message] of params.messages.entries()) {
    (preservedIndexSet.has(index) ? preservedMessages : summarizableMessages).push(message);
  }
  // Preserving recent assistant turns can orphan downstream toolResult messages.
  // Repair pairings here so compaction summarization doesn't trip strict providers.
  return {
    summarizableMessages: sanitizeToolUseResultPairing(summarizableMessages),
    preservedMessages,
  };
}

function formatContextSegments(messages: AgentMessage[]): string[] {
  const frames = classifyToolUseResultPairing(messages);
  // A call-bearing assistant and all occurrence-matched results are one context
  // atom; keeping remainder messages separate lets later terminal text survive.
  const toolSegments = new Map<AgentMessage, AgentMessage[]>(
    frames.map((frame) => [
      frame.assistant,
      [
        frame.assistant,
        ...frame.occurrences.flatMap((occurrence) =>
          occurrence.sourceResult ? [occurrence.sourceResult] : [],
        ),
      ],
    ]),
  );
  return messages.flatMap((message) => {
    if (message.role === "toolResult") {
      // Paired results render with their assistant message; unclaimed results
      // are unsafe context because their owning call is absent or ambiguous.
      return [];
    }
    const lines = (toolSegments.get(message) ?? [message])
      .map(formatContextMessage)
      .filter((line): line is string => Boolean(line));
    return lines.length > 0 ? [lines.join("\n")] : [];
  });
}

function formatBoundedContextSection(params: {
  messages: AgentMessage[];
  heading: string;
  truncatedMarker: string;
  truncatedLoss: NonNullable<ContextSection["truncatedLoss"]>;
  maxChars: number;
}): ContextSection {
  const segments = formatContextSegments(params.messages);
  if (segments.length === 0) {
    return { text: "", segmentStarts: [] };
  }

  let prefix = `${params.heading}\n`;
  let retained = segments;
  const truncated = !(prefix.length + segments.join("\n").length <= params.maxChars);
  if (truncated) {
    prefix += params.truncatedMarker;
    retained = [];
    let usedChars = prefix.length;
    for (const segment of segments.toReversed()) {
      const segmentChars = segment.length + (retained.length > 0 ? 1 : 0);
      if (usedChars + segmentChars > params.maxChars) {
        break;
      }
      retained.unshift(segment);
      usedChars += segmentChars;
    }
  }
  let offset = prefix.length;
  return {
    text: `${prefix}${retained.join("\n")}`,
    segmentStarts: retained.map((segment) => {
      const start = offset;
      offset += segment.length + 1;
      return start;
    }),
    ...(truncated ? { truncatedLoss: params.truncatedLoss } : {}),
  };
}

export function buildPreservedTurnsSection(
  messages: AgentMessage[],
  maxChars = MAX_SPLIT_TURN_CONTEXT_CHARS,
): ContextSection {
  return formatBoundedContextSection({
    messages,
    maxChars,
    heading: "\n\n## Recent turns preserved verbatim",
    truncatedMarker: PRESERVED_TURNS_TRUNCATED_MARKER,
    truncatedLoss: "preserved-turn-head",
  });
}

export function buildSplitTurnContextSection(
  messages: AgentMessage[],
  maxChars = MAX_SPLIT_TURN_CONTEXT_CHARS,
): ContextSection {
  return formatBoundedContextSection({
    messages,
    maxChars,
    heading: "**Turn Context (split turn):**\n",
    truncatedMarker: SPLIT_TURN_TRUNCATED_MARKER,
    truncatedLoss: "split-turn-head",
  });
}

/**
 * The boundary-scoped range a preparation was meant to cover: everything the
 * current context holds before its kept tail, minus the prior summary message
 * (that is re-distilled separately). Bounded by construction — it can never
 * reach behind the last reset/compaction boundary.
 */
export function collectPreparationRangeMessages(
  sessionManager: ExtensionContext["sessionManager"],
  firstKeptEntryId: string,
): AgentMessage[] {
  const entries = readSessionBranch(sessionManager);
  const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstKeptIndex < 0) {
    return [];
  }
  // Keep replay boundaries even when their retained entries precede the physical marker.
  // The core projector, not the preparation cut, owns which older entries remain visible.
  return projectBranchEntries(
    entries.filter(
      (entry, index) =>
        index < firstKeptIndex || entry.type === "compaction" || entry.type === "reset",
    ),
  ).filter((message) => message.role !== "compactionSummary");
}

export function readSessionBranch(
  sessionManager: ExtensionContext["sessionManager"],
): CoreSessionTreeEntry[] {
  return sessionManager.getBranch();
}

export function projectBranchEntries(entries: CoreSessionTreeEntry[]): AgentMessage[] {
  return buildCoreSessionContext(entries).messages;
}

export function containsRealConversation(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    isRealConversationMessage(message, allMessages, index),
  );
}
