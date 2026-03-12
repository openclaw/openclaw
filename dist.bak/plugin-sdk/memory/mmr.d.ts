/**
 * Maximal Marginal Relevance (MMR) re-ranking algorithm.
 *
 * MMR balances relevance with diversity by iteratively selecting results
 * that maximize: λ * relevance - (1-λ) * max_similarity_to_selected
 *
 * @see Carbonell & Goldstein, "The Use of MMR, Diversity-Based Reranking" (1998)
 */
export type MMRItem = {
    id: string;
    score: number;
    content: string;
};
export type MMRConfig = {
    /** Enable/disable MMR re-ranking. Default: false (opt-in) */
    enabled: boolean;
    /** Lambda parameter: 0 = max diversity, 1 = max relevance. Default: 0.7 */
    lambda: number;
};
export declare const DEFAULT_MMR_CONFIG: MMRConfig;
/**
 * Tokenize text for Jaccard similarity computation.
 * Extracts alphanumeric tokens and normalizes to lowercase.
 */
export declare function tokenize(text: string): Set<string>;
/**
 * Compute Jaccard similarity between two token sets.
 * Returns a value in [0, 1] where 1 means identical sets.
 */
export declare function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number;
/**
 * Compute text similarity between two content strings using Jaccard on tokens.
 */
export declare function textSimilarity(contentA: string, contentB: string): number;
/**
 * Compute MMR score for a candidate item.
 * MMR = λ * relevance - (1-λ) * max_similarity_to_selected
 */
export declare function computeMMRScore(relevance: number, maxSimilarity: number, lambda: number): number;
/**
 * Re-rank items using Maximal Marginal Relevance (MMR).
 *
 * The algorithm iteratively selects items that balance relevance with diversity:
 * 1. Start with the highest-scoring item
 * 2. For each remaining slot, select the item that maximizes the MMR score
 * 3. MMR score = λ * relevance - (1-λ) * max_similarity_to_already_selected
 *
 * @param items - Items to re-rank, must have score and content
 * @param config - MMR configuration (lambda, enabled)
 * @returns Re-ranked items in MMR order
 */
export declare function mmrRerank<T extends MMRItem>(items: T[], config?: Partial<MMRConfig>): T[];
/**
 * Apply MMR re-ranking to hybrid search results.
 * Adapts the generic MMR function to work with the hybrid search result format.
 */
export declare function applyMMRToHybridResults<T extends {
    score: number;
    snippet: string;
    path: string;
    startLine: number;
}>(results: T[], config?: Partial<MMRConfig>): T[];
