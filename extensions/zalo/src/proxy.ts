// Zalo plugin module implements proxy behavior.
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { makeProxyFetch, PROXY_FETCH_CLOSE } from "openclaw/plugin-sdk/fetch-runtime";
import type { ZaloFetch } from "./api.js";

/**
 * Cap distinct proxy-URL → fetcher entries retained for the process lifetime.
 * Distinct proxy URLs are normally rare; without a bound, config churn or
 * adversarial URL diversity can grow this Map without limit.
 */
const ZALO_PROXY_CACHE_MAX_ENTRIES = 64;

const proxyCache = new Map<string, ZaloFetch>();

export function resolveZaloProxyFetch(proxyUrl?: string | null): ZaloFetch | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  const cached = proxyCache.get(trimmed);
  if (cached) {
    return cached;
  }
  const fetcher = makeProxyFetch(trimmed) as ZaloFetch;
  // Close the Undici ProxyAgent dispatcher for the entry that will be evicted.
  if (proxyCache.size >= ZALO_PROXY_CACHE_MAX_ENTRIES) {
    const oldestKey = proxyCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = proxyCache.get(oldestKey);
      const closing = oldest as { [PROXY_FETCH_CLOSE]?: () => void } | undefined;
      closing?.[PROXY_FETCH_CLOSE]?.();
    }
  }
  proxyCache.set(trimmed, fetcher);
  // Keep the newest proxy fetchers while bounding process-lifetime retention.
  pruneMapToMaxSize(proxyCache, ZALO_PROXY_CACHE_MAX_ENTRIES);
  return fetcher;
}
