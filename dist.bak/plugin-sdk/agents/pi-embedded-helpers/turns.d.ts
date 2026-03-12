import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * Validates and fixes conversation turn sequences for Gemini API.
 * Gemini requires strict alternating user→assistant→tool→user pattern.
 * Merges consecutive assistant messages together.
 */
export declare function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[];
export declare function mergeConsecutiveUserTurns(previous: Extract<AgentMessage, {
    role: "user";
}>, current: Extract<AgentMessage, {
    role: "user";
}>): Extract<AgentMessage, {
    role: "user";
}>;
/**
 * Validates and fixes conversation turn sequences for Anthropic API.
 * Anthropic requires strict alternating user→assistant pattern.
 * Merges consecutive user messages together.
 */
export declare function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[];
