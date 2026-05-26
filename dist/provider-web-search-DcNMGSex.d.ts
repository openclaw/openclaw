import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { U as WebSearchProviderPlugin } from "./types-core-DxqEkbXr.js";
//#region src/agents/tools/web-search-citation-redirect.d.ts
/**
 * Resolve a citation redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out.
 */
declare function resolveCitationRedirectUrl(url: string): Promise<string>;
//#endregion
//#region src/agents/tools/web-search-provider-common.d.ts
type SearchConfigRecord = (NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web ? Web extends {
  search?: infer Search;
} ? Search : never : never) & Record<string, unknown>;
declare const DEFAULT_SEARCH_COUNT = 5;
declare const MAX_SEARCH_COUNT = 10;
declare function resolveSearchTimeoutSeconds(searchConfig?: SearchConfigRecord): number;
declare function resolveSearchCacheTtlMs(searchConfig?: SearchConfigRecord): number;
declare function resolveSearchCount(value: unknown, fallback: number): number;
declare function readConfiguredSecretString(value: unknown, path: string): string | undefined;
declare function readProviderEnvValue(envVars: string[]): string | undefined;
declare function withTrustedWebSearchEndpoint<T>(params: {
  url: string;
  timeoutSeconds: number;
  init: RequestInit;
  signal?: AbortSignal;
}, run: (response: Response) => Promise<T>): Promise<T>;
declare function withSelfHostedWebSearchEndpoint<T>(params: {
  url: string;
  timeoutSeconds: number;
  init: RequestInit;
  signal?: AbortSignal;
}, run: (response: Response) => Promise<T>): Promise<T>;
declare function postTrustedWebToolsJson<T>(params: {
  url: string;
  timeoutSeconds: number;
  apiKey: string;
  body: Record<string, unknown>;
  errorLabel: string;
  maxErrorBytes?: number;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
}, parseResponse: (response: Response) => Promise<T>): Promise<T>;
declare function throwWebSearchApiError(res: Response, providerLabel: string): Promise<never>;
declare function resolveSiteName(url: string | undefined): string | undefined;
declare const FRESHNESS_TO_RECENCY: Record<string, string>;
declare function isoToPerplexityDate(iso: string): string | undefined;
declare function normalizeToIsoDate(value: string): string | undefined;
declare function parseIsoDateRange(params: {
  rawDateAfter?: string;
  rawDateBefore?: string;
  invalidDateAfterMessage: string;
  invalidDateBeforeMessage: string;
  invalidDateRangeMessage: string;
  docs?: string;
}): {
  dateAfter?: string;
  dateBefore?: string;
} | {
  error: "invalid_date" | "invalid_date_range";
  message: string;
  docs: string;
};
declare function normalizeFreshness(value: string | undefined, provider: "brave" | "perplexity"): string | undefined;
declare function readCachedSearchPayload(cacheKey: string): Record<string, unknown> | undefined;
declare function buildSearchCacheKey(parts: Array<string | number | boolean | undefined>): string;
declare function writeCachedSearchPayload(cacheKey: string, payload: Record<string, unknown>, ttlMs: number): void;
declare function buildUnsupportedSearchFilterResponse(params: Record<string, unknown>, provider: string, docs?: string): {
  error: string;
  message: string;
  docs: string;
} | undefined;
//#endregion
//#region src/agents/tools/web-search-provider-credentials.d.ts
declare function resolveWebSearchProviderCredential(params: {
  credentialValue: unknown;
  path: string;
  envVars: string[];
}): string | undefined;
//#endregion
//#region src/plugin-sdk/provider-web-search.d.ts
/**
 * @deprecated Implement provider-owned `createTool(...)` directly on the
 * returned WebSearchProviderPlugin instead of routing through core.
 */
declare function createPluginBackedWebSearchProvider(provider: WebSearchProviderPlugin): WebSearchProviderPlugin;
//#endregion
export { withTrustedWebSearchEndpoint as C, withSelfHostedWebSearchEndpoint as S, resolveCitationRedirectUrl as T, resolveSearchCacheTtlMs as _, MAX_SEARCH_COUNT as a, resolveSiteName as b, buildUnsupportedSearchFilterResponse as c, normalizeToIsoDate as d, parseIsoDateRange as f, readProviderEnvValue as g, readConfiguredSecretString as h, FRESHNESS_TO_RECENCY as i, isoToPerplexityDate as l, readCachedSearchPayload as m, resolveWebSearchProviderCredential as n, SearchConfigRecord as o, postTrustedWebToolsJson as p, DEFAULT_SEARCH_COUNT as r, buildSearchCacheKey as s, createPluginBackedWebSearchProvider as t, normalizeFreshness as u, resolveSearchCount as v, writeCachedSearchPayload as w, throwWebSearchApiError as x, resolveSearchTimeoutSeconds as y };