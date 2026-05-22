import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
type AssistantMessage = Extract<AgentMessage, {
    role: "assistant";
}>;
type RecoveryAssessment = "valid" | "incomplete-thinking" | "incomplete-text";
type RecoverySessionMeta = {
    id: string;
    recoveredAnthropicThinking?: boolean;
};
export declare const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";
export declare function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage;
/**
 * Strip thinking blocks with clearly invalid replay signatures.
 *
 * Anthropic and Bedrock reject persisted thinking blocks when the signature is
 * absent, empty, or blank. They are also the authority for opaque signature
 * validity, so this intentionally avoids local length or shape heuristics.
 */
export declare function stripInvalidThinkingSignatures(messages: AgentMessage[]): AgentMessage[];
/**
 * Strip `type: "thinking"` and `type: "redacted_thinking"` content blocks from
 * all assistant messages except the latest one.
 *
 * Thinking blocks in the latest assistant turn are preserved verbatim so
 * providers that require replay signatures can continue the conversation.
 *
 * If a non-latest assistant message becomes empty after stripping, it is
 * replaced with a synthetic non-empty text block to preserve turn structure
 * through provider adapters that filter blank text blocks.
 *
 * Returns the original array reference when nothing was changed (callers can
 * use reference equality to skip downstream work).
 */
export declare function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[];
export declare function dropReasoningFromHistory(messages: AgentMessage[]): AgentMessage[];
export declare function assessLastAssistantMessage(message: AgentMessage): RecoveryAssessment;
export declare function sanitizeThinkingForRecovery(messages: AgentMessage[]): {
    messages: AgentMessage[];
    prefill: boolean;
};
export declare function wrapAnthropicStreamWithRecovery(innerStreamFn: StreamFn, sessionMeta: RecoverySessionMeta): StreamFn;
export {};
