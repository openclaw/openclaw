import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
export { stripDowngradedToolCallText, stripMinimaxToolCallXml, } from "../shared/text/assistant-visible-text.js";
export { stripModelSpecialTokens } from "../shared/text/model-special-tokens.js";
export declare function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage;
/**
 * Strip thinking tags and their content from text.
 * This is a safety net for cases where the model outputs <think> tags
 * that slip through other filtering mechanisms.
 */
export declare function stripThinkingTagsFromText(text: string): string;
export declare function extractAssistantVisibleText(msg: AssistantMessage): string;
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
export declare const THINKING_TAG_SCAN_RE: RegExp;
export declare function splitThinkingTaggedText(text: string): ThinkTaggedSplitBlock[] | null;
export declare function promoteThinkingTagsToBlocks(message: AssistantMessage): void;
export declare function extractThinkingFromTaggedText(text: string): string;
export declare function extractThinkingFromTaggedStream(text: string): string;
export declare function inferToolMetaFromArgs(toolName: string, args: unknown): string | undefined;
