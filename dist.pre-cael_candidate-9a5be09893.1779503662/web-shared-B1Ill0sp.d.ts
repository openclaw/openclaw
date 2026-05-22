import { i as GuardedFetchResult, r as GuardedFetchOptions } from "./fetch-guard-BgaCy73h.js";

//#region src/agents/tools/web-guarded-fetch.d.ts
type WebToolGuardedFetchOptions = Omit<GuardedFetchOptions, "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns"> & {
  timeoutSeconds?: number;
  useEnvProxy?: boolean;
};
type WebToolEndpointFetchOptions = Omit<WebToolGuardedFetchOptions, "policy" | "useEnvProxy">;
declare function fetchWithWebToolsNetworkGuard(params: WebToolGuardedFetchOptions): Promise<GuardedFetchResult>;
declare function withTrustedWebToolsEndpoint<T>(params: WebToolEndpointFetchOptions, run: (result: {
  response: Response;
  finalUrl: string;
}) => Promise<T>): Promise<T>;
declare function withSelfHostedWebToolsEndpoint<T>(params: WebToolEndpointFetchOptions, run: (result: {
  response: Response;
  finalUrl: string;
}) => Promise<T>): Promise<T>;
declare function withStrictWebToolsEndpoint<T>(params: WebToolEndpointFetchOptions, run: (result: {
  response: Response;
  finalUrl: string;
}) => Promise<T>): Promise<T>;
//#endregion
//#region src/agents/tools/web-shared.d.ts
type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  insertedAt: number;
};
declare const DEFAULT_TIMEOUT_SECONDS = 30;
declare const DEFAULT_CACHE_TTL_MINUTES = 15;
declare function resolveTimeoutSeconds(value: unknown, fallback: number): number;
declare function resolveCacheTtlMs(value: unknown, fallbackMinutes: number): number;
declare function normalizeCacheKey(value: string): string;
declare function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): {
  value: T;
  cached: boolean;
} | null;
declare function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void;
declare function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal;
type ReadResponseTextResult = {
  text: string;
  truncated: boolean;
  bytesRead: number;
};
declare function readResponseText(res: Response, options?: {
  maxBytes?: number;
}): Promise<ReadResponseTextResult>;
//#endregion
export { normalizeCacheKey as a, resolveCacheTtlMs as c, writeCache as d, fetchWithWebToolsNetworkGuard as f, withTrustedWebToolsEndpoint as h, ReadResponseTextResult as i, resolveTimeoutSeconds as l, withStrictWebToolsEndpoint as m, DEFAULT_CACHE_TTL_MINUTES as n, readCache as o, withSelfHostedWebToolsEndpoint as p, DEFAULT_TIMEOUT_SECONDS as r, readResponseText as s, CacheEntry as t, withTimeout as u };