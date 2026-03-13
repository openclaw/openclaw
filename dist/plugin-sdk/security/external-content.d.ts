/**
 * Check if content contains suspicious patterns that may indicate injection.
 */
export declare function detectSuspiciousPatterns(content: string): string[];
export type ExternalContentSource = "email" | "webhook" | "api" | "browser" | "channel_metadata" | "web_search" | "web_fetch" | "unknown";
export type WrapExternalContentOptions = {
    /** Source of the external content */
    source: ExternalContentSource;
    /** Original sender information (e.g., email address) */
    sender?: string;
    /** Subject line (for emails) */
    subject?: string;
    /** Whether to include detailed security warning */
    includeWarning?: boolean;
};
/**
 * Wraps external untrusted content with security boundaries and warnings.
 *
 * This function should be used whenever processing content from external sources
 * (emails, webhooks, API calls from untrusted clients) before passing to LLM.
 *
 * @example
 * ```ts
 * const safeContent = wrapExternalContent(emailBody, {
 *   source: "email",
 *   sender: "user@example.com",
 *   subject: "Help request"
 * });
 * // Pass safeContent to LLM instead of raw emailBody
 * ```
 */
export declare function wrapExternalContent(content: string, options: WrapExternalContentOptions): string;
/**
 * Builds a safe prompt for handling external content.
 * Combines the security-wrapped content with contextual information.
 */
export declare function buildSafeExternalPrompt(params: {
    content: string;
    source: ExternalContentSource;
    sender?: string;
    subject?: string;
    jobName?: string;
    jobId?: string;
    timestamp?: string;
}): string;
/**
 * Checks if a session key indicates an external hook source.
 */
export declare function isExternalHookSession(sessionKey: string): boolean;
/**
 * Extracts the hook type from a session key.
 */
export declare function getHookType(sessionKey: string): ExternalContentSource;
/**
 * Wraps web search/fetch content with security markers.
 * This is a simpler wrapper for web tools that just need content wrapped.
 */
export declare function wrapWebContent(content: string, source?: "web_search" | "web_fetch"): string;
