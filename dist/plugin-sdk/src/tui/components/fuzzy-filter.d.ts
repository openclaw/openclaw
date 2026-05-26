/**
 * Shared fuzzy filtering utilities for select list components.
 */
/**
 * Find index where query matches at a word boundary in text.
 * Returns null if no match.
 */
export declare function findWordBoundaryIndex(text: string, query: string): number | null;
/**
 * Filter items using pre-lowercased searchTextLower field.
 * Supports space-separated tokens (all must match).
 */
export declare function fuzzyFilterLower<T extends {
    searchTextLower?: string;
}>(items: T[], queryLower: string): T[];
/**
 * Prepare items for fuzzy filtering by pre-computing lowercase search text.
 */
export declare function prepareSearchItems<T extends {
    label?: string;
    description?: string;
    searchText?: string;
}>(items: T[]): (T & {
    searchTextLower: string;
})[];
