import { getContextWindowCaches } from "./context-cache.js";
import { beginContextWindowCacheRefresh } from "./context-runtime-state.js";

export type ContextWindowCatalogFixture = {
  entries: Array<{
    id: string;
    provider?: string;
    contextWindow?: number;
    contextTokens?: number;
  }>;
  staticEntries?: ContextWindowCatalogFixture["entries"];
};

export function resetContextWindowCacheForTest(): void {
  beginContextWindowCacheRefresh();
  const caches = getContextWindowCaches();
  caches.configuredTokenCache.clear();
  caches.discoveredTokenCache.clear();
  caches.contextWindowCache.clear();
}
