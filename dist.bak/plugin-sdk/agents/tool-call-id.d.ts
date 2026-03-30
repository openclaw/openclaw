import type { AgentMessage } from "@mariozechner/pi-agent-core";
export type ToolCallIdMode = "strict" | "strict9";
export type ToolCallLike = {
    id: string;
    name?: string;
};
/**
 * Sanitize a tool call ID to be compatible with various providers.
 *
 * - "strict" mode: only [a-zA-Z0-9]
 * - "strict9" mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
 */
export declare function sanitizeToolCallId(id: string, mode?: ToolCallIdMode): string;
export declare function extractToolCallsFromAssistant(msg: Extract<AgentMessage, {
    role: "assistant";
}>): ToolCallLike[];
export declare function extractToolResultId(msg: Extract<AgentMessage, {
    role: "toolResult";
}>): string | null;
export declare function isValidCloudCodeAssistToolId(id: string, mode?: ToolCallIdMode): boolean;
/**
 * Sanitize tool call IDs for provider compatibility.
 *
 * @param messages - The messages to sanitize
 * @param mode - "strict" (alphanumeric only) or "strict9" (alphanumeric length 9)
 */
export declare function sanitizeToolCallIdsForCloudCodeAssist(messages: AgentMessage[], mode?: ToolCallIdMode): AgentMessage[];
