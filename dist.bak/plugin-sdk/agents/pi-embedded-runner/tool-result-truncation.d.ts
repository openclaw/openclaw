import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * Hard character limit for a single tool result text block.
 * Even for the largest context windows (~2M tokens), a single tool result
 * should not exceed ~400K characters (~100K tokens).
 * This acts as a safety net when we don't know the context window size.
 */
export declare const HARD_MAX_TOOL_RESULT_CHARS = 400000;
type ToolResultTruncationOptions = {
    suffix?: string;
    minKeepChars?: number;
};
/**
 * Truncate a single text string to fit within maxChars, preserving the beginning.
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
 * Find oversized tool result entries in a session and truncate them.
 *
 * This operates on the session file by:
 * 1. Opening the session manager
 * 2. Walking the current branch to find oversized tool results
 * 3. Branching from before the first oversized tool result
 * 4. Re-appending all entries from that point with truncated tool results
 *
 * @returns Object indicating whether any truncation was performed
 */
export declare function truncateOversizedToolResultsInSession(params: {
    sessionFile: string;
    contextWindowTokens: number;
    sessionId?: string;
    sessionKey?: string;
}): Promise<{
    truncated: boolean;
    truncatedCount: number;
    reason?: string;
}>;
/**
 * Truncate oversized tool results in an array of messages (in-memory).
 * Returns a new array with truncated messages.
 *
 * This is used as a pre-emptive guard before sending messages to the LLM,
 * without modifying the session file.
 */
export declare function truncateOversizedToolResultsInMessages(messages: AgentMessage[], contextWindowTokens: number): {
    messages: AgentMessage[];
    truncatedCount: number;
};
/**
 * Check if a tool result message exceeds the size limit for a given context window.
 */
export declare function isOversizedToolResult(msg: AgentMessage, contextWindowTokens: number): boolean;
/**
 * Estimate whether the session likely has oversized tool results that caused
 * a context overflow. Used as a heuristic to decide whether to attempt
 * tool result truncation before giving up.
 */
export declare function sessionLikelyHasOversizedToolResults(params: {
    messages: AgentMessage[];
    contextWindowTokens: number;
}): boolean;
export {};
