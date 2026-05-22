//#region src/shared/text/assistant-visible-text.d.ts
declare function stripToolCallXmlTags(text: string, options?: {
  stripFunctionCallsXmlPayloads?: boolean;
  stripFunctionResponseAfterPluralToolCalls?: boolean;
}): string;
/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls.
 */
declare function stripMinimaxToolCallXml(text: string): string;
declare function stripLegacyBracketToolCallBlocks(text: string): string;
/**
 * Strip downgraded tool call text representations that leak into user-visible
 * text content when replaying history across providers.
 */
declare function stripDowngradedToolCallText(text: string): string;
type AssistantVisibleTextSanitizerProfile = "delivery" | "history" | "internal-scaffolding";
declare function sanitizeAssistantVisibleTextWithProfile(text: string, profile?: AssistantVisibleTextSanitizerProfile): string;
declare function stripAssistantInternalScaffolding(text: string): string;
/**
 * Canonical user-visible assistant text sanitizer for delivery and history
 * extraction paths. Keeps prose, removes internal scaffolding.
 */
declare function sanitizeAssistantVisibleText(text: string): string;
/**
 * Backwards-compatible trim wrapper.
 * Prefer sanitizeAssistantVisibleTextWithProfile for new call sites.
 */
declare function sanitizeAssistantVisibleTextWithOptions(text: string, options?: {
  trim?: "none" | "both";
}): string;
//#endregion
export { stripAssistantInternalScaffolding as a, stripMinimaxToolCallXml as c, sanitizeAssistantVisibleTextWithProfile as i, stripToolCallXmlTags as l, sanitizeAssistantVisibleText as n, stripDowngradedToolCallText as o, sanitizeAssistantVisibleTextWithOptions as r, stripLegacyBracketToolCallBlocks as s, AssistantVisibleTextSanitizerProfile as t };