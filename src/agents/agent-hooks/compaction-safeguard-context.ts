/** Preserves recent turns and renders bounded, atomic verbatim context sections. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  extractCompactionMessageText as extractMessageText,
  formatCompactionUserLabel,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { classifyToolUseResultPairing } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AgentMessage } from "../runtime/index.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";

// Split-turn context supplements the generated summary and must not claim its
// guaranteed half of the final artifact before common finalization runs.
const MAX_SPLIT_TURN_CONTEXT_CHARS = Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2);
const SPLIT_TURN_TRUNCATED_MARKER = "[Earlier split-turn messages truncated]\n";
const PRESERVED_TURNS_TRUNCATED_MARKER = "[Earlier preserved messages truncated]\n";
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_RECENT_TURN_TEXT_CHARS = 600;
const MAX_PRESERVED_TOOL_RESULT_CHARS = 160;

/**
 * Build the reserved suffix that follows the summary body. Both the provider
 * and LLM paths use this so diagnostic sections survive truncation.
 */
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

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content == null || typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "[non-text content]";
  }
  const typeCounts = new Map<string, number>();
  const blocks: readonly unknown[] = content;
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typeRaw = "type" in block ? block.type : undefined;
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

function formatContextMessage(message: AgentMessage): string | null {
  let roleLabel: string;
  if (message.role === "assistant") {
    roleLabel = "Assistant";
  } else if (message.role === "user") {
    roleLabel = formatCompactionUserLabel(message);
  } else if (message.role === "toolResult") {
    const toolName = message.toolName;
    const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
    roleLabel = `Tool result (${safeToolName})`;
  } else {
    return null;
  }
  const rendered = [extractMessageText(message), formatNonTextPlaceholder(message.content)]
    .filter(Boolean)
    .join("\n");
  if (!rendered) {
    return null;
  }
  // Tool output is bulk the summary already distills; keep only a head excerpt
  // so it cannot crowd generated facts out of the bounded artifact.
  const limit =
    message.role === "toolResult" ? MAX_PRESERVED_TOOL_RESULT_CHARS : MAX_RECENT_TURN_TEXT_CHARS;
  const trimmed =
    rendered.length <= limit
      ? rendered
      : message.role === "toolResult"
        ? `${truncateUtf16Safe(rendered, limit)} [${rendered.length - limit} more chars omitted at compaction]`
        : `${truncateUtf16Safe(rendered, limit)}...`;
  return `- ${roleLabel}: ${trimmed}`;
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
    maxChars,
    messages,
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
    maxChars,
    messages,
    heading: "**Turn Context (split turn):**\n",
    truncatedMarker: SPLIT_TURN_TRUNCATED_MARKER,
    truncatedLoss: "split-turn-head",
  });
}
