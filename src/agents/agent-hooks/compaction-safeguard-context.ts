import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  capCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AgentMessage } from "../runtime/index.js";
import { repairToolUseResultPairing } from "../session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";

export const SPLIT_TURN_SECTION_HEADING = "**Turn Context (split turn):**";
export const MAX_SPLIT_TURN_CONTEXT_CHARS = Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2);

const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const SPLIT_TURN_TRUNCATED_MARKER = "[Earlier split-turn messages truncated]\n";
const PRESERVED_TURNS_TRUNCATED_MARKER = "[Earlier preserved messages truncated]\n";
const MAX_REQUIRED_ASK_CONTEXT_CHARS = 2_000;
const REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER = "\n[... split-turn ask context truncated ...]\n";

export type CompactionLoss =
  | "summary-tail"
  | "suffix-head"
  | "split-turn-head"
  | "split-turn-tail"
  | "preserved-turn-head";

export type ContextSection = {
  text: string;
  segmentStarts: number[];
  truncatedLoss?: CompactionLoss;
};

export function extractMessageText(message: AgentMessage): string {
  // SAFETY: Read only an optional unknown field across built-in and custom message roles.
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim();
  }
  return Array.isArray(content)
    ? content
        .flatMap((block) => {
          const text =
            // SAFETY: The object check above permits reading optional fields as unknown.
            block && typeof block === "object" ? (block as { text?: unknown }).text : undefined;
          return typeof text === "string" && text.trim() ? [text.trim()] : [];
        })
        .join("\n")
    : "";
}

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content == null || typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "[non-text content]";
  }
  const typeCounts = new Map<string, number>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    // SAFETY: The object check above permits reading optional fields as unknown.
    const typeRaw = (block as { type?: unknown }).type;
    const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
    if (type === "text") {
      continue;
    }
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  return typeCounts.size > 0
    ? `[non-text content: ${Array.from(typeCounts, ([type, count]) =>
        count > 1 ? `${type} x${count}` : type,
      ).join(", ")}]`
    : null;
}

export function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summarizableMessages: AgentMessage[]; preservedMessages: AgentMessage[] } {
  const preserveTurns = Math.min(
    MAX_RECENT_TURNS_PRESERVE,
    Math.max(
      0,
      Math.floor(
        typeof params.recentTurnsPreserve === "number" &&
          Number.isFinite(params.recentTurnsPreserve)
          ? params.recentTurnsPreserve
          : 0,
      ),
    ),
  );
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
  return {
    summarizableMessages: repairToolUseResultPairing(summarizableMessages).messages,
    preservedMessages,
  };
}

function formatContextMessage(message: AgentMessage): string | null {
  let roleLabel: string;
  if (message.role === "assistant") {
    roleLabel = "Assistant";
  } else if (message.role === "user") {
    roleLabel = "User";
  } else if (message.role === "toolResult") {
    // SAFETY: Read only an optional unknown field across built-in and custom message roles.
    const toolName = (message as { toolName?: unknown }).toolName;
    const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
    roleLabel = `Tool result (${safeToolName})`;
  } else {
    return null;
  }
  const rendered = [
    extractMessageText(message),
    // SAFETY: Read only an optional unknown field across built-in and custom message roles.
    formatNonTextPlaceholder((message as { content?: unknown }).content),
  ]
    .filter(Boolean)
    .join("\n");
  if (!rendered) {
    return null;
  }
  const trimmed =
    rendered.length > MAX_RECENT_TURN_TEXT_CHARS
      ? `${truncateUtf16Safe(rendered, MAX_RECENT_TURN_TEXT_CHARS)}...`
      : rendered;
  return `- ${roleLabel}: ${trimmed}`;
}

function formatContextSegments(messages: AgentMessage[]): string[] {
  const pairing = classifyToolUseResultPairing(messages);
  const toolSegments = new Map<AgentMessage, AgentMessage[]>(
    pairing.frames.map((frame) => [
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
  maxChars: number;
  truncatedMarker: string;
  truncatedLoss: CompactionLoss;
  onTruncated?: () => void;
}): ContextSection {
  const segments = formatContextSegments(params.messages);
  if (segments.length === 0) {
    return { text: "", segmentStarts: [] };
  }

  const completePrefix = `${params.heading}\n`;
  const complete = `${completePrefix}${segments.join("\n")}`;
  if (complete.length <= params.maxChars) {
    let offset = completePrefix.length;
    return {
      text: complete,
      segmentStarts: segments.map((segment) => {
        const start = offset;
        offset += segment.length + 1;
        return start;
      }),
    };
  }

  const prefix = `${completePrefix}${params.truncatedMarker}`;
  const retained: string[] = [];
  let usedChars = prefix.length;
  for (const segment of segments.toReversed()) {
    const segmentChars = segment.length + (retained.length > 0 ? 1 : 0);
    if (usedChars + segmentChars > params.maxChars) {
      break;
    }
    retained.unshift(segment);
    usedChars += segmentChars;
  }
  params.onTruncated?.();
  let offset = prefix.length;
  return {
    text: `${prefix}${retained.join("\n")}`,
    segmentStarts: retained.map((segment) => {
      const start = offset;
      offset += segment.length + 1;
      return start;
    }),
    truncatedLoss: params.truncatedLoss,
  };
}

export function buildPreservedTurnsSection(messages: AgentMessage[]): ContextSection {
  return formatBoundedContextSection({
    messages,
    heading: "\n\n## Recent turns preserved verbatim",
    maxChars: MAX_SPLIT_TURN_CONTEXT_CHARS,
    truncatedMarker: PRESERVED_TURNS_TRUNCATED_MARKER,
    truncatedLoss: "preserved-turn-head",
  });
}

export function buildSplitTurnContextSection(
  messages: AgentMessage[],
  onTruncated?: () => void,
): ContextSection {
  return formatBoundedContextSection({
    messages,
    heading: "**Turn Context (split turn):**\n",
    maxChars: MAX_SPLIT_TURN_CONTEXT_CHARS,
    truncatedMarker: SPLIT_TURN_TRUNCATED_MARKER,
    truncatedLoss: "split-turn-head",
    onTruncated,
  });
}

export function formatGeneratedSplitTurnSection(summary: string, onTruncated?: () => void): string {
  const heading = `${SPLIT_TURN_SECTION_HEADING}\n\n`;
  const summaryBudget = MAX_SPLIT_TURN_CONTEXT_CHARS - heading.length;
  const nestedSummary = summary.replace(/^##(?=[ \t]+\S)/gmu, "###");
  const cappedSummary = capCompactionSummary(nestedSummary, summaryBudget);
  if (cappedSummary.length < nestedSummary.length) {
    onTruncated?.();
  }
  return `${heading}${cappedSummary}`;
}

export function formatRequiredAskContext(rawAsk: string): string {
  const source = rawAsk.trim();
  if (source.length <= MAX_REQUIRED_ASK_CONTEXT_CHARS) {
    return source;
  }
  const contentBudget =
    MAX_REQUIRED_ASK_CONTEXT_CHARS - REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER.length;
  const headBudget = Math.floor(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${truncateUtf16Safe(source, headBudget)}${REQUIRED_ASK_CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(source, -tailBudget)}`;
}

export function extractLatestUserAsk(messages: AgentMessage[]): string | null {
  for (const message of messages.toReversed()) {
    if (message.role === "user") {
      const ask = extractMessageText(message);
      if (ask) {
        return ask;
      }
    }
  }
  return null;
}
