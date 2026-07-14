// Zalo-owned proxy fetcher cache: bounded Map + local ProxyAgent dispose.
// Lifecycle stays in this plugin — no core Symbol.for close contract.
import { createHttp1ProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import type { ZaloFetch } from "./api.js";

/**
 * Cap distinct proxy-URL → fetcher entries retained for the process lifetime.
 * Distinct proxy URLs are normally rare; without a bound, config churn or
 * adversarial URL diversity can grow this Map without limit.
 */
const ZALO_PROXY_CACHE_MAX_ENTRIES = 64;

/** Non-enumerable tag for production proofs (same Symbol.for key as makeProxyFetch). */
const ZALO_PROXY_FETCH_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");

type ZaloProxyCacheEntry = {
  fetch: ZaloFetch;
  dispose: () => void;
  /** Active monitor leases; dispose waits until zero when retired. */
  leases: number;
  /** Removed from the cache; dispose runs when leases hits zero. */
  retired: boolean;
  proxyUrl: string;
};

const proxyCache = new Map<string, ZaloProxyCacheEntry>();
/** Entries removed from the map but still leased (deferred dispose). */
const retiredByUrl = new Map<string, ZaloProxyCacheEntry>();

function createZaloProxyCacheEntry(proxyUrl: string): ZaloProxyCacheEntry {
  // createHttp1ProxyAgent already applies managed proxy TLS options.
  const agent = createHttp1ProxyAgent({ uri: proxyUrl });
  let disposed = false;
  const fetchFn = (async (input: string, init?: RequestInit) => {
    // Fail closed after dispose so retained callers cannot rebuild an untracked agent.
    if (disposed) {
      throw new Error(`zalo proxy fetch disposed for ${proxyUrl}`);
    }
    return fetchWithRuntimeDispatcher(input, {
      ...init,
      dispatcher: agent,
    });
  }) as ZaloFetch;
  Object.defineProperty(fetchFn, ZALO_PROXY_FETCH_URL, {
    value: proxyUrl,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return {
    fetch: fetchFn,
    leases: 0,
    retired: false,
    proxyUrl,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      void agent.close().catch(() => undefined);
    },
  };
}

function disposeEntryWhenIdle(entry: ZaloProxyCacheEntry): void {
  if (entry.leases > 0) {
    retiredByUrl.set(entry.proxyUrl, entry);
    return;
  }
  retiredByUrl.delete(entry.proxyUrl);
  entry.dispose();
}

/** Evict one unused entry, or retire the oldest leased entry without closing it yet. */
function evictOldestCacheEntry(): void {
  for (const [key, entry] of proxyCache) {
    if (entry.leases > 0) {
      continue;
    }
    proxyCache.delete(key);
    entry.retired = true;
    disposeEntryWhenIdle(entry);
    return;
  }
  const oldestKey = proxyCache.keys().next().value;
  if (oldestKey === undefined) {
    return;
  }
  const oldest = proxyCache.get(oldestKey);
  if (!oldest) {
    return;
  }
  proxyCache.delete(oldestKey);
  oldest.retired = true;
  disposeEntryWhenIdle(oldest);
}

function getOrCreateEntry(trimmed: string): ZaloProxyCacheEntry {
  const cached = proxyCache.get(trimmed);
  if (cached) {
    // Touch insertion order so active URLs are not the first eviction candidates.
    proxyCache.delete(trimmed);
    proxyCache.set(trimmed, cached);
    return cached;
  }
  while (proxyCache.size >= ZALO_PROXY_CACHE_MAX_ENTRIES) {
    evictOldestCacheEntry();
  }
  const entry = createZaloProxyCacheEntry(trimmed);
  proxyCache.set(trimmed, entry);
  return entry;
}

/**
 * Resolve a Zalo proxy fetch wrapper for short-lived callers (send/probe).
 * Does not take a lease — eviction may dispose the entry once unused.
 */
export function resolveZaloProxyFetch(proxyUrl?: string | null): ZaloFetch | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  return getOrCreateEntry(trimmed).fetch;
}

/**
 * Acquire a leased proxy fetch for long-lived owners (monitor).
 * Eviction retires the cache slot but defers ProxyAgent close until release.
 */
export function acquireZaloProxyFetch(proxyUrl?: string | null): ZaloFetch | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  const entry = getOrCreateEntry(trimmed);
  entry.leases += 1;
  return entry.fetch;
}

/** Release a monitor lease; closes the agent when the entry was retired. */
export function releaseZaloProxyFetch(proxyUrl?: string | null): void {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return;
  }
  const entry = proxyCache.get(trimmed) ?? retiredByUrl.get(trimmed);
  if (!entry || entry.leases <= 0) {
    return;
  }
  entry.leases -= 1;
  if (entry.retired && entry.leases === 0) {
    disposeEntryWhenIdle(entry);
  }
}
