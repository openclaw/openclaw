//#region packages/memory-host-sdk/src/host/query-expansion.d.ts
declare function isQueryStopWordToken(token: string): boolean;
/**
 * Extract keywords from a conversational query for FTS search.
 *
 * Examples:
 * - "that thing we discussed about the API" → ["discussed", "API"]
 * - "之前讨论的那个方案" → ["讨论", "方案"]
 * - "what was the solution for the bug" → ["solution", "bug"]
 */
declare function extractKeywords(query: string, opts?: {
  ftsTokenizer?: "unicode61" | "trigram";
}): string[];
//#endregion
export { isQueryStopWordToken as n, extractKeywords as t };