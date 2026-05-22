export declare function stripToolMessages(messages: unknown[]): unknown[];
/**
 * Sanitize text content to strip tool call markers and thinking tags.
 * This ensures user-facing text doesn't leak internal tool representations.
 */
export declare function sanitizeTextContent(text: string): string;
export declare function extractAssistantText(message: unknown): string | undefined;
