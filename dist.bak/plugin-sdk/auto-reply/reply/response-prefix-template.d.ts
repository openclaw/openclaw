/**
 * Template interpolation for response prefix.
 *
 * Supports variables like `{model}`, `{provider}`, `{thinkingLevel}`, etc.
 * Variables are case-insensitive and unresolved ones remain as literal text.
 */
export type ResponsePrefixContext = {
    /** Short model name (e.g., "gpt-5.2", "claude-opus-4-6") */
    model?: string;
    /** Full model ID including provider (e.g., "openai-codex/gpt-5.2") */
    modelFull?: string;
    /** Provider name (e.g., "openai-codex", "anthropic") */
    provider?: string;
    /** Current thinking level (e.g., "high", "low", "off") */
    thinkingLevel?: string;
    /** Agent identity name */
    identityName?: string;
};
/**
 * Interpolate template variables in a response prefix string.
 *
 * @param template - The template string with `{variable}` placeholders
 * @param context - Context object with values for interpolation
 * @returns The interpolated string, or undefined if template is undefined
 *
 * @example
 * resolveResponsePrefixTemplate("[{model} | think:{thinkingLevel}]", {
 *   model: "gpt-5.2",
 *   thinkingLevel: "high"
 * })
 * // Returns: "[gpt-5.2 | think:high]"
 */
export declare function resolveResponsePrefixTemplate(template: string | undefined, context: ResponsePrefixContext): string | undefined;
/**
 * Extract short model name from a full model string.
 *
 * Strips:
 * - Provider prefix (e.g., "openai/" from "openai/gpt-5.2")
 * - Date suffixes (e.g., "-20260205" from "claude-opus-4-6-20260205")
 * - Common version suffixes (e.g., "-latest")
 *
 * @example
 * extractShortModelName("openai-codex/gpt-5.2") // "gpt-5.2"
 * extractShortModelName("claude-opus-4-6-20260205") // "claude-opus-4-6"
 * extractShortModelName("gpt-5.2-latest") // "gpt-5.2"
 */
export declare function extractShortModelName(fullModel: string): string;
/**
 * Check if a template string contains any template variables.
 */
export declare function hasTemplateVariables(template: string | undefined): boolean;
