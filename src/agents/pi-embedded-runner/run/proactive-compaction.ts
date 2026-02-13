/**
 * Proactive compaction - Check if session needs compaction before prompting model.
 *
 * This prevents Discord sessions (and all sessions) from bypassing compaction
 * and hitting model's 200k context limit instead of compacting at
 * contextTokens * maxHistoryShare threshold.
 *
 * Issue: https://github.com/openclaw/openclaw/issues/11224
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { lookupContextTokens } from "../../context.js";

/**
 * Check if session needs proactive compaction based on contextTokens and maxHistoryShare.
 *
 * @returns true if session exceeds threshold and should be compacted
 */
export function needsProactiveCompaction(params: {
  messages: AgentMessage[];
  contextTokens?: number;
  maxHistoryShare?: number;
  modelId: string;
}): boolean {
  const { messages, contextTokens, maxHistoryShare, modelId } = params;

  // Get effective contextTokens from config (highest priority), then model lookup, then default
  const effectiveContextTokens = contextTokens ?? lookupContextTokens(modelId) ?? DEFAULT_CONTEXT_TOKENS;
  const effectiveMaxHistoryShare = maxHistoryShare ?? 0.5;

  // Calculate budget: contextTokens * maxHistoryShare
  const budgetTokens = Math.max(1, Math.floor(effectiveContextTokens * effectiveMaxHistoryShare));

  // Estimate current message tokens
  const currentTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);

  // Check if we exceed budget
  const needsCompaction = currentTokens > budgetTokens;

  if (needsCompaction) {
    const overage = currentTokens - budgetTokens;
    console.warn(
      `[proactive-compaction] session exceeds budget: ${currentTokens} > ${budgetTokens} ` +
        `(by ${overage} tokens, ${(overage / effectiveContextTokens * 100).toFixed(1)}% overage)`
    );
  }

  return needsCompaction;
}
