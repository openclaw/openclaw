/**
 * Query expansion for FTS-only search mode.
 *
 * When no embedding provider is available, we fall back to FTS (full-text search).
 * FTS works best with specific keywords, but users often ask conversational queries
 * like "that thing we discussed yesterday" or "之前讨论的那个方案".
 *
 * This module extracts meaningful keywords from such queries to improve FTS results.
 */
/**
 * Extract keywords from a conversational query for FTS search.
 *
 * Examples:
 * - "that thing we discussed about the API" → ["discussed", "API"]
 * - "之前讨论的那个方案" → ["讨论", "方案"]
 * - "what was the solution for the bug" → ["solution", "bug"]
 */
export declare function extractKeywords(query: string): string[];
/**
 * Expand a query for FTS search.
 * Returns both the original query and extracted keywords for OR-matching.
 *
 * @param query - User's original query
 * @returns Object with original query and extracted keywords
 */
export declare function expandQueryForFts(query: string): {
    original: string;
    keywords: string[];
    expanded: string;
};
/**
 * Type for an optional LLM-based query expander.
 * Can be provided to enhance keyword extraction with semantic understanding.
 */
export type LlmQueryExpander = (query: string) => Promise<string[]>;
/**
 * Expand query with optional LLM assistance.
 * Falls back to local extraction if LLM is unavailable or fails.
 */
export declare function expandQueryWithLlm(query: string, llmExpander?: LlmQueryExpander): Promise<string[]>;
