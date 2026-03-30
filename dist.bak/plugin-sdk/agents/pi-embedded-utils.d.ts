import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
export declare function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage;
/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls. This removes:
 * - <invoke name="...">...</invoke> blocks
 * - </minimax:tool_call> closing tags
 */
export declare function stripMinimaxToolCallXml(text: string): string;
/**
 * Strip downgraded tool call text representations that leak into text content.
 * When replaying history to Gemini, tool calls without `thought_signature` are
 * downgraded to text blocks like `[Tool Call: name (ID: ...)]`. These should
 * not be shown to users.
 */
export declare function stripDowngradedToolCallText(text: string): string;
/**
 * Strip thinking tags and their content from text.
 * This is a safety net for cases where the model outputs <think> tags
 * that slip through other filtering mechanisms.
 */
export declare function stripThinkingTagsFromText(text: string): string;
export declare function extractAssistantText(msg: AssistantMessage): string;
export declare function extractAssistantThinking(msg: AssistantMessage): string;
export declare function formatReasoningMessage(text: string): string;
type ThinkTaggedSplitBlock = {
    type: "thinking";
    thinking: string;
} | {
    type: "text";
    text: string;
};
export declare function splitThinkingTaggedText(text: string): ThinkTaggedSplitBlock[] | null;
export declare function promoteThinkingTagsToBlocks(message: AssistantMessage): void;
export declare function extractThinkingFromTaggedText(text: string): string;
export declare function extractThinkingFromTaggedStream(text: string): string;
export declare function inferToolMetaFromArgs(toolName: string, args: unknown): string | undefined;
export {};
