import { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentMessage } from "@earendil-works/pi-agent-core";

//#region src/shared/text/model-special-tokens.d.ts
declare function stripModelSpecialTokens(text: string): string;
//#endregion
//#region src/agents/pi-embedded-utils.d.ts
declare function isAssistantMessage(msg: AgentMessage | undefined): msg is AssistantMessage;
/**
 * Strip thinking tags and their content from text.
 * This is a safety net for cases where the model outputs <think> tags
 * that slip through other filtering mechanisms.
 */
declare function stripThinkingTagsFromText(text: string): string;
declare function extractAssistantVisibleText(msg: AssistantMessage): string;
declare function extractAssistantText(msg: AssistantMessage): string;
declare function extractAssistantThinking(msg: AssistantMessage): string;
declare function formatReasoningMessage(text: string): string;
type ThinkTaggedSplitBlock = {
  type: "thinking";
  thinking: string;
} | {
  type: "text";
  text: string;
};
declare const THINKING_TAG_SCAN_RE: RegExp;
declare function splitThinkingTaggedText(text: string): ThinkTaggedSplitBlock[] | null;
declare function promoteThinkingTagsToBlocks(message: AssistantMessage): void;
declare function extractThinkingFromTaggedText(text: string): string;
declare function extractThinkingFromTaggedStream(text: string): string;
declare function inferToolMetaFromArgs(toolName: string, args: unknown, options?: {
  detailMode?: "explain" | "raw";
}): string | undefined;
//#endregion
export { extractThinkingFromTaggedStream as a, inferToolMetaFromArgs as c, splitThinkingTaggedText as d, stripThinkingTagsFromText as f, extractAssistantVisibleText as i, isAssistantMessage as l, extractAssistantText as n, extractThinkingFromTaggedText as o, stripModelSpecialTokens as p, extractAssistantThinking as r, formatReasoningMessage as s, THINKING_TAG_SCAN_RE as t, promoteThinkingTagsToBlocks as u };