import { CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES } from "./session-catalog-index.js";
import { MAX_TITLE_SEARCH_CATALOG_PAGES } from "./session-catalog-parsing.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";

export type CodexCatalogPageCacheEntry = {
  expiresAt: number;
  value: CodexSessionCatalogPage;
  head: boolean;
};

export function codexCatalogPageCacheKey(
  params: CodexSessionCatalogPageParams,
  agentId: string | undefined,
  sourceHomeId: string | undefined,
  maxScanPages = MAX_TITLE_SEARCH_CATALOG_PAGES,
): string {
  // Mirror listPage's search/cwd normalization; these trimmed values are what reach app-server.
  return JSON.stringify([
    agentId,
    sourceHomeId ?? null,
    params.cursor ?? null,
    params.limit ?? null,
    params.searchTerm?.trim().toLocaleLowerCase() || null,
    params.cwd?.trim() || null,
    params.searchTerm?.trim() ? maxScanPages : null,
  ]);
}

/** Favor at most one walk's page count across all queries; older discovery still shares the cap. */
export function retainCodexCatalogPage(
  pages: Map<string, CodexCatalogPageCacheEntry>,
  key: string,
  entry: CodexCatalogPageCacheEntry,
  headWalk: boolean,
): void {
  entry.head ||= headWalk;
  pages.delete(key);
  pages.set(key, entry);
  let headCount = 0;
  for (const page of pages.values()) {
    if (page.head) {
      headCount++;
    }
  }
  for (const page of pages.values()) {
    if (headCount <= MAX_TITLE_SEARCH_CATALOG_PAGES) {
      break;
    }
    if (page.head) {
      page.head = false;
      headCount--;
    }
  }
  for (const [candidate, page] of pages) {
    if (pages.size <= CODEX_SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES) {
      break;
    }
    if (!page.head) {
      pages.delete(candidate);
    }
  }
}
