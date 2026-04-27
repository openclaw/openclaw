import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
/**
 * Default hard cap for a single live tool result text block.
 *
 * Pi already truncates tool results aggressively when serializing old history
 * for compaction summaries. For the live request path we still keep a bounded
 * request-local ceiling so oversized tool output cannot dominate the next turn.
 */
export declare const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 16000;
/**
 * Backwards-compatible alias for older call sites/tests.
 */
export declare const HARD_MAX_TOOL_RESULT_CHARS = 16000;
type ToolResultTruncationOptions = {
    suffix?: string | ((truncatedChars: number) => string);
    minKeepChars?: number;
};
export declare const MIN_TRUNCATED_TEXT_CHARS: number;
/**
 * Truncate a single text string to fit within maxChars.
 *
 * Uses a head+tail strategy when the tail contains important content
 * (errors, results, JSON structure), otherwise preserves the beginning.
 * This ensures error messages and summaries at the end of tool output
 * aren't lost during truncation.
 */
export declare function truncateToolResultText(text: string, maxChars: number, options?: ToolResultTruncationOptions): string;
/**
 * Calculate the maximum allowed characters for a single tool result
 * based on the model's context window tokens.
 *
 * Uses a rough 4 chars ≈ 1 token heuristic (conservative for English text;
 * actual ratio varies by tokenizer).
 */
export declare function calculateMaxToolResultChars(contextWindowTokens: number): number;
export declare function calculateMaxToolResultCharsWithCap(contextWindowTokens: number, hardCapChars: number): number;
export declare function resolveLiveToolResultMaxChars(params: {
    contextWindowTokens: number;
    cfg?: OpenClawConfig;
    agentId?: string | null;
}): number;
/**
 * Get the total character count of text content blocks in a tool result message.
 */
export declare function getToolResultTextLength(msg: AgentMessage): number;
/**
 * Truncate a tool result message's text content blocks to fit within maxChars.
 * Returns a new message (does not mutate the original).
 */
export declare function truncateToolResultMessage(msg: AgentMessage, maxChars: number, options?: ToolResultTruncationOptions): AgentMessage;
/**
 * Truncate oversized tool results in an array of messages (in-memory).
 * Returns a new array with truncated messages.
 *
 * This is used as a pre-emptive guard before sending messages to the LLM,
 * without modifying the session file.
 */
export declare function truncateOversizedToolResultsInMessages(messages: AgentMessage[], contextWindowTokens: number, maxCharsOverride?: number): {
    messages: AgentMessage[];
    truncatedCount: number;
};
export type ToolResultReductionPotential = {
    maxChars: number;
    aggregateBudgetChars: number;
    toolResultCount: number;
    totalToolResultChars: number;
    oversizedCount: number;
    oversizedReducibleChars: number;
    aggregateReducibleChars: number;
    maxReducibleChars: number;
};
export declare function estimateToolResultReductionPotential(params: {
    messages: AgentMessage[];
    contextWindowTokens: number;
    maxCharsOverride?: number;
}): ToolResultReductionPotential;
export declare function truncateOversizedToolResultsInSessionManager(params: {
    sessionManager: SessionManager;
    contextWindowTokens: number;
    maxCharsOverride?: number;
    sessionFile?: string;
    sessionId?: string;
    sessionKey?: string;
}): {
    truncated: boolean;
    truncatedCount: number;
    reason?: string;
};
export declare function truncateOversizedToolResultsInSession(params: {
    sessionFile: string;
    contextWindowTokens: number;
    maxCharsOverride?: number;
    sessionId?: string;
    sessionKey?: string;
}): Promise<{
    truncated: boolean;
    truncatedCount: number;
    reason?: string;
}>;
/**
 * Check if a tool result message exceeds the size limit for a given context window.
 */
export declare function isOversizedToolResult(msg: AgentMessage, contextWindowTokens: number, maxCharsOverride?: number): boolean;
export declare function sessionLikelyHasOversizedToolResults(params: {
    messages: AgentMessage[];
    contextWindowTokens: number;
    maxCharsOverride?: number;
}): boolean;
export {};
