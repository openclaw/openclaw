/**
 * Store cache for tool result summaries.
 *
 * Provides a way to access cached store instances without importing
 * the full store module (which depends on lancedb).
 */

/**
 * Minimal interface for ToolResultSummaryStore operations needed by truncation handler.
 */
export interface ToolResultSummaryStoreLike {
  getByToolCallId(toolCallId: string): Promise<{ summary: string } | null>;
}

/**
 * Global store cache by resolved DB path.
 * Used for sharing store instances across different contexts (e.g., truncation handler).
 */
const storeCache = new Map<string, ToolResultSummaryStoreLike>();

/**
 * Cache a store instance by database path.
 */
export function cacheStore(dbPath: string, store: ToolResultSummaryStoreLike): void {
  storeCache.set(dbPath, store);
}

/**
 * Get a cached store by database path.
 * Returns undefined if no store has been created for this path.
 */
export function getCachedStore(dbPath: string): ToolResultSummaryStoreLike | undefined {
  return storeCache.get(dbPath);
}
