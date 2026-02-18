import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextDecayConfig } from "../../../config/types.agent-defaults.js";
import type { SwappedFileStore } from "../../context-decay/file-store.js";
import type { GroupSummaryStore, SummaryStore } from "../../context-decay/summary-store.js";
import { computeTurnAges } from "../../context-decay/turn-ages.js";
import { repairToolUseResultPairing } from "../../session-transcript-repair.js";

export interface DecayStats {
  thinkingBlocksStripped: number;
  thinkingCharsFreed: number;
  toolResultsSummarized: number;
  summarizeCharsFreed: number;
  groupSummariesApplied: number;
  groupCharsFreed: number;
  toolResultsStripped: number;
  stripCharsFreed: number;
  messagesCapped: number;
  capCharsFreed: number;
}

export function createEmptyDecayStats(): DecayStats {
  return {
    thinkingBlocksStripped: 0,
    thinkingCharsFreed: 0,
    toolResultsSummarized: 0,
    summarizeCharsFreed: 0,
    groupSummariesApplied: 0,
    groupCharsFreed: 0,
    toolResultsStripped: 0,
    stripCharsFreed: 0,
    messagesCapped: 0,
    capCharsFreed: 0,
  };
}

export function getMessageContentChars(msg: AgentMessage): number {
  const content = (msg as unknown as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string") {
      total += b.text.length;
    }
    if (typeof b.thinking === "string") {
      total += b.thinking.length;
    }
    if ((b.type === "tool_use" || b.type === "toolCall") && b.input) {
      try {
        total += JSON.stringify(b.input).length;
      } catch {
        total += 128;
      }
    }
  }
  return total;
}

function isEnabled(value: number | undefined | null): value is number {
  return typeof value === "number" && value >= 1;
}

/**
 * Apply graduated context decay to messages.
 * Processing order:
 * 1. Strip thinking blocks from old assistant messages
 * 1.5. Apply file swaps for aged tool results
 * 2. Apply group summaries (replace anchor + absorbed messages in-place)
 * 3. Apply pre-computed individual summaries for old tool results (skip grouped messages)
 * 4. Strip tool results past the strip threshold
 * 5. Apply maxContextMessages hard cap
 * 6. Repair tool use/result pairing
 */
export function applyContextDecay(params: {
  messages: AgentMessage[];
  config: ContextDecayConfig;
  summaryStore: SummaryStore;
  groupSummaryStore?: GroupSummaryStore;
  swappedFileStore?: SwappedFileStore;
  stats?: DecayStats;
}): AgentMessage[] {
  const { messages, config, summaryStore, groupSummaryStore, swappedFileStore, stats } = params;

  if (messages.length === 0) {
    return messages;
  }

  // Check if any decay is actually enabled
  const hasStripThinking = isEnabled(config.stripThinkingAfterTurns);
  const hasSwap =
    isEnabled(config.swapToolResultsAfterTurns) &&
    swappedFileStore &&
    Object.keys(swappedFileStore).length > 0;
  const hasSummarize = isEnabled(config.summarizeToolResultsAfterTurns);
  const hasGroupSummarize = isEnabled(config.summarizeWindowAfterTurns);
  const hasStrip = isEnabled(config.stripToolResultsAfterTurns);
  const hasMaxMessages = isEnabled(config.maxContextMessages);

  if (
    !hasStripThinking &&
    !hasSwap &&
    !hasSummarize &&
    !hasGroupSummarize &&
    !hasStrip &&
    !hasMaxMessages
  ) {
    return messages;
  }

  // Validate graduated decay: summarize should fire before strip
  if (hasSummarize && hasStrip) {
    if (config.summarizeToolResultsAfterTurns! >= config.stripToolResultsAfterTurns!) {
      // Misconfigured: summarize threshold >= strip threshold.
      // Summarize is effectively skipped by the per-message guard below.
    }
  }

  // Build lookup sets from group summary store
  const anchorIndices = new Set<number>();
  const absorbedIndices = new Set<number>();
  const anchorToSummary = new Map<number, string>();

  if (groupSummaryStore && groupSummaryStore.length > 0) {
    for (const entry of groupSummaryStore) {
      anchorIndices.add(entry.anchorIndex);
      const label = `[Group Summary — Turns ${entry.turnRange[0]}-${entry.turnRange[1]}]\n${entry.summary}`;
      anchorToSummary.set(entry.anchorIndex, label);
      for (const idx of entry.indices) {
        if (idx !== entry.anchorIndex) {
          absorbedIndices.add(idx);
        }
      }
    }
  }

  const turnAges = computeTurnAges(messages);
  let changed = false;
  let result = messages.map((msg, idx) => {
    const age = turnAges.get(idx) ?? 0;
    let mutated = false;
    let current = msg;

    // 1. Strip thinking blocks from old assistant messages
    if (
      hasStripThinking &&
      current.role === "assistant" &&
      age >= config.stripThinkingAfterTurns!
    ) {
      if (Array.isArray(current.content)) {
        const filtered = current.content.filter(
          (block: unknown) => (block as Record<string, unknown>)?.type !== "thinking",
        );
        if (filtered.length !== current.content.length) {
          const charsBefore = stats ? getMessageContentChars(current) : 0;
          const blocksRemoved = current.content.length - filtered.length;
          current = { ...current, content: filtered };
          if (stats) {
            stats.thinkingBlocksStripped += blocksRemoved;
            stats.thinkingCharsFreed += charsBefore - getMessageContentChars(current);
          }
          mutated = true;
        }
      }
    }

    // 1.5. Apply file swaps for aged tool results
    if (
      hasSwap &&
      !anchorIndices.has(idx) &&
      !absorbedIndices.has(idx) &&
      current.role === "toolResult" &&
      age >= config.swapToolResultsAfterTurns! &&
      swappedFileStore[idx]
    ) {
      // Only apply swap if not past summarize or strip threshold (those take precedence)
      const skipForSummarize =
        hasSummarize && age >= config.summarizeToolResultsAfterTurns! && summaryStore[idx];
      const skipForStrip = hasStrip && age >= config.stripToolResultsAfterTurns!;
      if (!skipForSummarize && !skipForStrip) {
        const entry = swappedFileStore[idx];
        current = {
          ...current,
          content: [
            { type: "text", text: `[Tool result saved to ${entry.filePath}]\n${entry.hint}` },
          ],
        } as AgentMessage;
        mutated = true;
      }
    }

    // 2. Apply group summaries
    if (anchorIndices.has(idx)) {
      // Anchor message: replace content with group summary
      const charsBefore = stats ? getMessageContentChars(current) : 0;
      const summaryText = anchorToSummary.get(idx)!;
      if (current.role === "user") {
        current = { ...current, content: summaryText } as AgentMessage;
      } else {
        current = {
          ...current,
          content: [{ type: "text", text: summaryText }],
        } as AgentMessage;
      }
      if (stats) {
        stats.groupSummariesApplied++;
        stats.groupCharsFreed += charsBefore - getMessageContentChars(current);
      }
      mutated = true;
    } else if (absorbedIndices.has(idx)) {
      // Absorbed message: replace with placeholder, preserve structure
      const charsBefore = stats ? getMessageContentChars(current) : 0;
      if (current.role === "user") {
        current = {
          ...current,
          content: "[Absorbed into group summary above]",
        } as AgentMessage;
        mutated = true;
      } else if (current.role === "assistant") {
        // Preserve tool_use blocks structurally (id, name, empty input) for pairing
        if (Array.isArray(current.content)) {
          const contentArr = current.content as unknown as Array<Record<string, unknown>>;
          const preserved = contentArr
            .filter((block) => block.type === "tool_use")
            .map((block) => ({
              type: "tool_use" as const,
              id: block.id,
              name: block.name,
              input: {},
            }));
          const newContent = [
            { type: "text" as const, text: "[Absorbed into group summary above]" },
            ...preserved,
          ];
          current = { ...current, content: newContent } as unknown as AgentMessage;
        } else {
          current = {
            ...current,
            content: [{ type: "text", text: "[Absorbed into group summary above]" }],
          } as unknown as AgentMessage;
        }
        mutated = true;
      } else if (current.role === "toolResult") {
        // Preserve toolCallId and toolName for pairing
        current = {
          ...current,
          content: [{ type: "text", text: "[Absorbed into group summary above]" }],
        } as AgentMessage;
        mutated = true;
      }
      if (stats && mutated) {
        stats.groupCharsFreed += charsBefore - getMessageContentChars(current);
      }
    }

    // 3. Apply pre-computed individual summaries for old tool results (skip grouped msgs)
    if (
      hasSummarize &&
      !anchorIndices.has(idx) &&
      !absorbedIndices.has(idx) &&
      current.role === "toolResult" &&
      age >= config.summarizeToolResultsAfterTurns! &&
      summaryStore[idx]
    ) {
      // Only apply summary if we're not past the strip threshold
      const skipSummarize = hasStrip && age >= config.stripToolResultsAfterTurns!;
      if (!skipSummarize) {
        const charsBefore = stats ? getMessageContentChars(current) : 0;
        const entry = summaryStore[idx];
        current = {
          ...current,
          content: [{ type: "text", text: `[Summarized] ${entry.summary}` }],
        } as AgentMessage;
        if (stats) {
          stats.toolResultsSummarized++;
          stats.summarizeCharsFreed += charsBefore - getMessageContentChars(current);
        }
        mutated = true;
      }
    }

    // 4. Strip tool results past the strip threshold
    if (hasStrip && current.role === "toolResult" && age >= config.stripToolResultsAfterTurns!) {
      // Don't re-strip messages already handled by group summaries
      if (!anchorIndices.has(idx) && !absorbedIndices.has(idx)) {
        const charsBefore = stats ? getMessageContentChars(current) : 0;
        current = {
          ...current,
          content: [
            {
              type: "text",
              text: `[Tool result removed — aged past ${config.stripToolResultsAfterTurns} turns]`,
            },
          ],
        } as AgentMessage;
        if (stats) {
          stats.toolResultsStripped++;
          stats.stripCharsFreed += charsBefore - getMessageContentChars(current);
        }
        mutated = true;
      }
    }

    if (mutated) {
      changed = true;
    }
    return current;
  });

  // 5. Apply maxContextMessages hard cap
  let truncated = false;
  if (hasMaxMessages && result.length > config.maxContextMessages!) {
    if (stats) {
      const dropped = result.slice(0, result.length - config.maxContextMessages!);
      stats.messagesCapped = dropped.length;
      stats.capCharsFreed = dropped.reduce((sum, m) => sum + getMessageContentChars(m), 0);
    }
    result = result.slice(result.length - config.maxContextMessages!);
    changed = true;
    truncated = true;
  }

  if (!changed) {
    return messages;
  }

  // 6. Repair tool use/result pairing after message truncation.
  //    Only needed when maxContextMessages dropped messages from the front,
  //    which can orphan tool_use or toolResult entries.
  if (truncated) {
    result = repairToolUseResultPairing(result).messages;
  }

  return result;
}
