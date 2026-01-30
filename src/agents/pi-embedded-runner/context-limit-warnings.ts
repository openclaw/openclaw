import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { estimateMessagesTokens } from "../compaction.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { log } from "./logger.js";

/**
 * Context limit warning thresholds (configurable via agent config).
 */
export type ContextLimitThresholds = {
  /** Soft warning threshold (default: 80%) */
  softWarnPercent: number;
  /** Hard gate threshold - demands save + auto-compact (default: 90%) */
  hardGatePercent: number;
  /** Block threshold - force save/compact, refuse API call (default: 95%) */
  blockPercent: number;
};

export const DEFAULT_CONTEXT_THRESHOLDS: ContextLimitThresholds = {
  softWarnPercent: 80,
  hardGatePercent: 90,
  blockPercent: 95,
};

/**
 * Safety margin for output token estimation (20% buffer for inaccuracy).
 */
export const OUTPUT_TOKEN_SAFETY_MARGIN = 1.2;

/**
 * Result of context limit check.
 */
export type ContextLimitCheckResult = {
  /** Current context usage in tokens */
  currentTokens: number;
  /** Maximum context window in tokens */
  maxTokens: number;
  /** Current context usage as percentage (0-100) */
  usagePercent: number;
  /** Action required based on threshold */
  action: "proceed" | "soft_warn" | "hard_gate" | "block";
  /** Warning message to inject (if any) */
  warningMessage?: string;
  /** Should auto-compact before continuing */
  shouldAutoCompact: boolean;
};

/**
 * Resolve context limit thresholds from config.
 */
export function resolveContextThresholds(config?: unknown): ContextLimitThresholds {
  const cfg = config as
    | {
        agents?: {
          defaults?: {
            contextLimits?: {
              softWarnPercent?: number;
              hardGatePercent?: number;
              blockPercent?: number;
            };
          };
        };
      }
    | undefined;
  const configured = cfg?.agents?.defaults?.contextLimits;
  return {
    softWarnPercent: configured?.softWarnPercent ?? DEFAULT_CONTEXT_THRESHOLDS.softWarnPercent,
    hardGatePercent: configured?.hardGatePercent ?? DEFAULT_CONTEXT_THRESHOLDS.hardGatePercent,
    blockPercent: configured?.blockPercent ?? DEFAULT_CONTEXT_THRESHOLDS.blockPercent,
  };
}

/**
 * Estimate output tokens for upcoming API call.
 * Uses a conservative estimate with safety margin.
 */
export function estimateOutputTokenBudget(params: {
  model?: { maxOutputTokens?: number } | unknown;
  safetyMargin?: number;
}): number {
  // Extract maxOutputTokens from model (handles various model types)
  const modelRecord = params.model as { maxOutputTokens?: number } | undefined;
  const maxOutput = modelRecord?.maxOutputTokens ?? 4096;
  const margin = params.safetyMargin ?? OUTPUT_TOKEN_SAFETY_MARGIN;
  return Math.ceil(maxOutput * margin);
}

/**
 * Calculate current context usage from messages.
 */
export function calculateContextUsage(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  estimatedOutputTokens?: number;
}): number {
  const messageTokens = estimateMessagesTokens(params.messages);
  // Convert system prompt to a message for token estimation
  const systemTokens = params.systemPrompt
    ? estimateTokens({
        role: "system",
        content: params.systemPrompt,
        timestamp: Date.now(),
      } as unknown as AgentMessage)
    : 0;
  const outputTokens = params.estimatedOutputTokens ?? 0;
  return messageTokens + systemTokens + outputTokens;
}

/**
 * Format warning message for context limit.
 */
export function formatContextWarningMessage(params: {
  usagePercent: number;
  currentTokens: number;
  maxTokens: number;
  action: "soft_warn" | "hard_gate" | "block";
}): string {
  const pct = params.usagePercent.toFixed(0);
  const current = (params.currentTokens / 1000).toFixed(0);
  const max = (params.maxTokens / 1000).toFixed(0);

  switch (params.action) {
    case "soft_warn":
      return `⚠️ Context at ${pct}% (${current}K/${max}K tokens). Save important work to files now.`;
    case "hard_gate":
      return `🚨 Context at ${pct}% (${current}K/${max}K tokens). SAVE YOUR WORK NOW - auto-compacting after this turn.`;
    case "block":
      return `🛑 Context limit reached (${pct}%, ${current}K/${max}K tokens). Compacting session before continuing.`;
    default:
      return `⚠️ Context at ${pct}% (${current}K/${max}K tokens).`;
  }
}

/**
 * Check context limit and determine action.
 */
export function checkContextLimit(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  systemPrompt?: string;
  estimatedOutputTokens?: number;
  thresholds?: ContextLimitThresholds;
}): ContextLimitCheckResult {
  const thresholds = params.thresholds ?? DEFAULT_CONTEXT_THRESHOLDS;
  const currentTokens = calculateContextUsage({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    estimatedOutputTokens: params.estimatedOutputTokens,
  });
  const maxTokens = params.maxContextTokens;
  const usagePercent = (currentTokens / maxTokens) * 100;

  // Determine action based on thresholds
  let action: ContextLimitCheckResult["action"];
  let shouldAutoCompact = false;
  let warningMessage: string | undefined;

  if (usagePercent >= thresholds.blockPercent) {
    action = "block";
    shouldAutoCompact = true;
    warningMessage = formatContextWarningMessage({
      usagePercent,
      currentTokens,
      maxTokens,
      action: "block",
    });
  } else if (usagePercent >= thresholds.hardGatePercent) {
    action = "hard_gate";
    shouldAutoCompact = true;
    warningMessage = formatContextWarningMessage({
      usagePercent,
      currentTokens,
      maxTokens,
      action: "hard_gate",
    });
  } else if (usagePercent >= thresholds.softWarnPercent) {
    action = "soft_warn";
    shouldAutoCompact = false;
    warningMessage = formatContextWarningMessage({
      usagePercent,
      currentTokens,
      maxTokens,
      action: "soft_warn",
    });
  } else {
    action = "proceed";
    shouldAutoCompact = false;
  }

  return {
    currentTokens,
    maxTokens,
    usagePercent,
    action,
    warningMessage,
    shouldAutoCompact,
  };
}

/**
 * Log warning message for context limit.
 * Note: Warning messages are logged, not injected into the conversation.
 * The agent relies on auto-compaction to manage context limits.
 */
export function logContextWarning(params: {
  warningMessage: string;
  checkpoint: "session_load" | "turn_boundary" | "intra_turn";
  usagePercent: number;
}): void {
  log.warn(`[${params.checkpoint}] ${params.warningMessage} (${params.usagePercent.toFixed(1)}%)`);
}

/**
 * Get max context tokens from session entry or model.
 */
export function resolveMaxContextTokens(params: {
  sessionEntry?: SessionEntry | null;
  modelContextWindow?: number;
  defaultTokens: number;
}): number {
  // Prefer session entry's stored contextTokens (from last run)
  if (params.sessionEntry?.contextTokens && params.sessionEntry.contextTokens > 0) {
    return params.sessionEntry.contextTokens;
  }
  // Fall back to model's context window
  if (params.modelContextWindow && params.modelContextWindow > 0) {
    return params.modelContextWindow;
  }
  // Last resort: default
  return params.defaultTokens;
}
