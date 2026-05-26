import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CacheEntry } from "./web-shared.js";
export type SearchConfigRecord = (NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web ? Web extends {
    search?: infer Search;
} ? Search : never : never) & Record<string, unknown>;
export declare const DEFAULT_SEARCH_COUNT = 5;
export declare const MAX_SEARCH_COUNT = 10;
export declare const SEARCH_CACHE: Map<string, CacheEntry<Record<string, unknown>>>;
export declare function resolveSearchTimeoutSeconds(searchConfig?: SearchConfigRecord): number;
export declare function resolveSearchCacheTtlMs(searchConfig?: SearchConfigRecord): number;
export declare function resolveSearchCount(value: unknown, fallback: number): number;
export declare function readConfiguredSecretString(value: unknown, path: string): string | undefined;
export declare function readProviderEnvValue(envVars: string[]): string | undefined;
export declare function withTrustedWebSearchEndpoint<T>(params: {
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
    signal?: AbortSignal;
}, run: (response: Response) => Promise<T>): Promise<T>;
export declare function withSelfHostedWebSearchEndpoint<T>(params: {
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
    signal?: AbortSignal;
}, run: (response: Response) => Promise<T>): Promise<T>;
export declare function postTrustedWebToolsJson<T>(params: {
    url: string;
    timeoutSeconds: number;
    apiKey: string;
    body: Record<string, unknown>;
    errorLabel: string;
    maxErrorBytes?: number;
    extraHeaders?: Record<string, string>;
    signal?: AbortSignal;
}, parseResponse: (response: Response) => Promise<T>): Promise<T>;
export declare function throwWebSearchApiError(res: Response, providerLabel: string): Promise<never>;
export declare function resolveSiteName(url: string | undefined): string | undefined;
export declare const FRESHNESS_TO_RECENCY: Record<string, string>;
export declare function isoToPerplexityDate(iso: string): string | undefined;
export declare function normalizeToIsoDate(value: string): string | undefined;
export declare function parseIsoDateRange(params: {
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
export declare function normalizeFreshness(value: string | undefined, provider: "brave" | "perplexity"): string | undefined;
export declare function readCachedSearchPayload(cacheKey: string): Record<string, unknown> | undefined;
export declare function buildSearchCacheKey(parts: Array<string | number | boolean | undefined>): string;
export declare function writeCachedSearchPayload(cacheKey: string, payload: Record<string, unknown>, ttlMs: number): void;
export declare function buildUnsupportedSearchFilterResponse(params: Record<string, unknown>, provider: string, docs?: string): {
    error: string;
    message: string;
    docs: string;
} | undefined;
