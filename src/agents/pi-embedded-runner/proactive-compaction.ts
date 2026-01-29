import fs from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { MoltbotConfig } from "../../config/config.js";
import { estimateMessagesTokens, SAFETY_MARGIN } from "../compaction.js";
import { resolveCompactionReserveTokensFloor } from "../pi-settings.js";
import { log } from "./logger.js";

export const DEFAULT_PROACTIVE_THRESHOLD_RATIO = 0.85;

export type ProactiveCompactionCheckResult = {
  shouldCompact: boolean;
  estimatedTokens: number;
  threshold: number;
  reason?: "no_session_file" | "empty_session" | "check_failed" | "below_threshold" | "exceeded";
};

/**
 * Resolve the token threshold at which proactive compaction should trigger.
 * Returns min(ratio-based threshold, reserve-based threshold).
 */
export function resolveProactiveThreshold(params: {
  contextTokens: number;
  config?: MoltbotConfig;
}): number {
  const { contextTokens, config } = params;
  const reserveTokensFloor = resolveCompactionReserveTokensFloor(config);
  const thresholdRatio =
    config?.agents?.defaults?.compaction?.proactiveThresholdRatio ??
    DEFAULT_PROACTIVE_THRESHOLD_RATIO;

  // Ratio-based: e.g., 85% of context
  const ratioThreshold = Math.floor(contextTokens * thresholdRatio);

  // Reserve-based: context minus reserve, with safety margin for estimation inaccuracy
  const reserveThreshold = Math.floor((contextTokens - reserveTokensFloor) / SAFETY_MARGIN);

  return Math.max(0, Math.min(ratioThreshold, reserveThreshold));
}

type SessionEntry = {
  type?: string;
  message?: AgentMessage;
};

/**
 * Read messages from a session JSONL file.
 * Returns an array of AgentMessages extracted from "message" type entries.
 */
async function readSessionMessages(sessionFile: string): Promise<AgentMessage[]> {
  const raw = await fs.readFile(sessionFile, "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const messages: AgentMessage[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SessionEntry;
      if (entry.type === "message" && entry.message) {
        messages.push(entry.message);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return messages;
}

/**
 * Check if proactive compaction should run before sending a request.
 * Reads the session file to estimate current tokens and compares against threshold.
 */
export async function checkProactiveCompaction(params: {
  sessionFile: string;
  contextTokens: number;
  config?: MoltbotConfig;
  promptTokenEstimate?: number;
}): Promise<ProactiveCompactionCheckResult> {
  const threshold = resolveProactiveThreshold({
    contextTokens: params.contextTokens,
    config: params.config,
  });

  // Check if session file exists
  try {
    await fs.access(params.sessionFile);
  } catch {
    return {
      shouldCompact: false,
      estimatedTokens: 0,
      threshold,
      reason: "no_session_file",
    };
  }

  try {
    const messages = await readSessionMessages(params.sessionFile);

    if (messages.length === 0) {
      return {
        shouldCompact: false,
        estimatedTokens: 0,
        threshold,
        reason: "empty_session",
      };
    }

    // Estimate tokens from existing messages
    const existingTokens = estimateMessagesTokens(messages);

    // Add estimate for the new prompt (default ~500 tokens if not provided)
    const promptEstimate = params.promptTokenEstimate ?? 500;

    // Apply safety margin to account for estimation inaccuracy
    const estimatedTotalTokens = Math.floor((existingTokens + promptEstimate) * SAFETY_MARGIN);

    const shouldCompact = estimatedTotalTokens >= threshold;

    return {
      shouldCompact,
      estimatedTokens: estimatedTotalTokens,
      threshold,
      reason: shouldCompact ? "exceeded" : "below_threshold",
    };
  } catch (err) {
    log.debug(
      `proactive compaction check failed (proceeding without): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      shouldCompact: false,
      estimatedTokens: 0,
      threshold,
      reason: "check_failed",
    };
  }
}
