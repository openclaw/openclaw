export declare function sanitizeRenderableText(text: string): string;
export declare function resolveFinalAssistantText(params: {
    finalText?: string | null;
    streamedText?: string | null;
    errorMessage?: string | null;
}): string;
export declare function composeThinkingAndContent(params: {
    thinkingText?: string;
    contentText?: string;
    showThinking?: boolean;
}): string;
/**
 * Extract ONLY thinking blocks from message content.
 * Model-agnostic: returns empty string if no thinking blocks exist.
 */
export declare function extractThinkingFromMessage(message: unknown): string;
/**
 * Extract ONLY text content blocks from message (excludes thinking).
 * Model-agnostic: works for any model with text content blocks.
 */
export declare function extractContentFromMessage(message: unknown): string;
export declare function extractTextFromMessage(message: unknown, opts?: {
    includeThinking?: boolean;
}): string;
export declare function isCommandMessage(message: unknown): boolean;
export declare function formatTokens(total?: number | null, context?: number | null): string;
export declare function formatContextUsageLine(params: {
    total?: number | null;
    context?: number | null;
    remaining?: number | null;
    percent?: number | null;
}): string;
export declare function asString(value: unknown, fallback?: string): string;
