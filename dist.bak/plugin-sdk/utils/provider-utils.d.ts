/**
 * Utility functions for provider-specific logic and capabilities.
 */
/**
 * Returns true if the provider requires reasoning to be wrapped in tags
 * (e.g. <think> and <final>) in the text stream, rather than using native
 * API fields for reasoning/thinking.
 */
export declare function isReasoningTagProvider(provider: string | undefined | null): boolean;
