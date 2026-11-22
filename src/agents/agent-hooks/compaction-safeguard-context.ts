/** Preserves recent turns and renders bounded, atomic verbatim context sections. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { MAX_COMPACTION_SUMMARY_CHARS } from "../../../packages/agent-core/src/harness/compaction/compaction-summary-budget.js";
import {
  extractCompactionMessageText as extractMessageText,
  formatCompactionUserLabel,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import {
  classifyToolPairingFacts,
  type ToolPairingMessageFact,
} from "../../../packages/agent-core/src/harness/session/tool-pairing-facts.js";
import { collectToolPairingMessageFact } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { copyString } from "../../../packages/agent-core/src/harness/utils/truncate.js";
import type { AgentMessage } from "../runtime/index.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";

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

/** No bodies/arguments: exact pairing inventory plus a detached, bounded text excerpt. */
export type CompactionContextMessageFact = {
  role: AgentMessage["role"];
  pairing: ToolPairingMessageFact | undefined;
  line: string | null;
};

export function collectCompactionContextMessageIdentity(
  message: AgentMessage,
): Pick<CompactionContextMessageFact, "role" | "pairing"> {
  const pairing = collectToolPairingMessageFact(message);
  if (pairing?.role === "assistant") {
    pairing.calls = pairing.calls.map((call) => ({
      ...call,
      id: copyString(call.id),
      name: call.name === undefined ? undefined : copyString(call.name),
    }));
  } else if (pairing?.role === "toolResult") {
    pairing.id = pairing.id === null ? null : copyString(pairing.id);
    pairing.name = pairing.name === undefined ? undefined : copyString(pairing.name);
  }
  return {
    role: message.role,
    pairing,
  };
}

export function collectCompactionContextMessageFact(
  message: AgentMessage,
): CompactionContextMessageFact {
  return {
    ...collectCompactionContextMessageIdentity(message),
    line: formatContextMessage(message),
  };
}

/** Indexes are relative to the selected sequence, before summarizable pairing repair. */
export function selectPreservedRecentTurnIndexes(
  messages: readonly Pick<CompactionContextMessageFact, "role" | "pairing">[],
  preserveTurns: number,
): Set<number> {
  if (preserveTurns <= 0) {
    return new Set();
  }
  const conversationIndexes = messages.flatMap((message, index) =>
    message.role === "user" || message.role === "assistant" ? [index] : [],
  );
  if (conversationIndexes.length === 0) {
    return new Set();
  }

  const userIndexes = conversationIndexes.filter((index) => messages[index]?.role === "user");
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
    const message = messages[index];
    if (message?.role === "assistant") {
      for (const toolCall of message.pairing?.role === "assistant" ? message.pairing.calls : []) {
        preservedToolCallIds.add(toolCall.id);
      }
    }
  }
  if (preservedToolCallIds.size > 0) {
    const preservedStartIndex = conversationIndexes.find((index) => preservedIndexSet.has(index))!;
    for (let index = preservedStartIndex; index < messages.length; index += 1) {
      const message = messages[index];
      if (message?.role !== "toolResult") {
        continue;
      }
      const toolResultId = message.pairing?.role === "toolResult" ? message.pairing.id : null;
      if (toolResultId && preservedToolCallIds.has(toolResultId)) {
        preservedIndexSet.add(index);
      }
    }
  }
  return preservedIndexSet;
}

export function splitPreservedRecentTurns(params: {
  messages: AgentMessage[];
  recentTurnsPreserve: number;
}): { summarizableMessages: AgentMessage[]; preservedMessages: AgentMessage[] } {
  if (params.recentTurnsPreserve <= 0) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
  }
  const facts = params.messages.map((message) => ({
    role: message.role,
    pairing: collectToolPairingMessageFact(message),
  }));
  const preservedIndexSet = selectPreservedRecentTurnIndexes(facts, params.recentTurnsPreserve);
  if (!facts.some((fact) => fact.role === "user" || fact.role === "assistant")) {
    return { summarizableMessages: params.messages, preservedMessages: [] };
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
  return copyString(`- ${roleLabel}: ${trimmed}`);
}

function formatContextSegments(messages: readonly CompactionContextMessageFact[]): string[] {
  const frames = classifyToolPairingFacts(messages.map((message) => message.pairing));
  // Occurrence ownership is recomputed for this selection, never sliced from another sequence.
  const toolSegments = new Map(
    frames.map((frame) => [
      messages[frame.startIndex],
      [
        frame.startIndex,
        ...frame.occurrences.flatMap((occurrence) =>
          occurrence.result ? [occurrence.result.index] : [],
        ),
      ],
    ]),
  );
  return messages.flatMap((message, index) => {
    if (message.role === "toolResult") {
      return [];
    }
    const lines = (toolSegments.get(message) ?? [index])
      .map((sourceIndex) => messages[sourceIndex]?.line)
      .filter((line): line is string => Boolean(line));
    return lines.length > 0 ? [lines.join("\n")] : [];
  });
}

function formatBoundedContextSection(params: {
  messages: readonly CompactionContextMessageFact[];
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

export function buildPreservedTurnsSectionFromFacts(
  messages: readonly CompactionContextMessageFact[],
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

function buildSplitTurnContextSectionFromFacts(
  messages: readonly CompactionContextMessageFact[],
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

export function buildPreservedTurnsSection(
  messages: AgentMessage[],
  maxChars = MAX_SPLIT_TURN_CONTEXT_CHARS,
): ContextSection {
  return buildPreservedTurnsSectionFromFacts(collectContextSequence(messages), maxChars);
}

export function buildSplitTurnContextSection(
  messages: AgentMessage[],
  maxChars = MAX_SPLIT_TURN_CONTEXT_CHARS,
): ContextSection {
  return buildSplitTurnContextSectionFromFacts(collectContextSequence(messages), maxChars);
}

function collectContextSequence(messages: AgentMessage[]): CompactionContextMessageFact[] {
  const identities = new Map<AgentMessage, CompactionContextMessageFact>();
  return messages.map((message) => {
    const fact = identities.get(message) ?? collectCompactionContextMessageFact(message);
    identities.set(message, fact);
    return fact;
  });
}
