import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextDecayConfig } from "../../../config/types.agent-defaults.js";
import type { GroupSummaryStore, SummaryStore } from "../../context-decay/summary-store.js";
import { computeTurnAges } from "../../context-decay/turn-ages.js";
import { repairToolUseResultPairing } from "../../session-transcript-repair.js";

function isEnabled(value: number | undefined | null): value is number {
  return typeof value === "number" && value >= 1;
}

/**
 * Apply graduated context decay to messages.
 * Processing order:
 * 1. Strip thinking blocks from old assistant messages
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
}): AgentMessage[] {
  const { messages, config, summaryStore, groupSummaryStore } = params;

  if (messages.length === 0) {
    return messages;
  }

  // Check if any decay is actually enabled
  const hasStripThinking = isEnabled(config.stripThinkingAfterTurns);
  const hasSummarize = isEnabled(config.summarizeToolResultsAfterTurns);
  const hasGroupSummarize = isEnabled(config.summarizeWindowAfterTurns);
  const hasStrip = isEnabled(config.stripToolResultsAfterTurns);
  const hasMaxMessages = isEnabled(config.maxContextMessages);

  if (!hasStripThinking && !hasSummarize && !hasGroupSummarize && !hasStrip && !hasMaxMessages) {
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
          current = { ...current, content: filtered };
          mutated = true;
        }
      }
    }

    // 2. Apply group summaries
    if (anchorIndices.has(idx)) {
      // Anchor message: replace content with group summary
      const summaryText = anchorToSummary.get(idx)!;
      if (current.role === "user") {
        current = { ...current, content: summaryText } as AgentMessage;
      } else {
        current = {
          ...current,
          content: [{ type: "text", text: summaryText }],
        } as AgentMessage;
      }
      mutated = true;
    } else if (absorbedIndices.has(idx)) {
      // Absorbed message: replace with placeholder, preserve structure
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
        const entry = summaryStore[idx];
        current = {
          ...current,
          content: [{ type: "text", text: `[Summarized] ${entry.summary}` }],
        } as AgentMessage;
        mutated = true;
      }
    }

    // 4. Strip tool results past the strip threshold
    if (hasStrip && current.role === "toolResult" && age >= config.stripToolResultsAfterTurns!) {
      // Don't re-strip messages already handled by group summaries
      if (!anchorIndices.has(idx) && !absorbedIndices.has(idx)) {
        current = {
          ...current,
          content: [
            {
              type: "text",
              text: `[Tool result removed — aged past ${config.stripToolResultsAfterTurns} turns]`,
            },
          ],
        } as AgentMessage;
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
