import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
// Zalo tests cover proxy cache bounding.
import { beforeEach, describe, expect, it, vi } from "vitest";

const closeSpy = vi.hoisted(() => vi.fn());
const makeProxyFetchMock = vi.hoisted(() =>
  vi.fn((proxyUrl: string) => {
    const fetchFn: Record<string | symbol, unknown> = vi.fn(
      async () => new Response("ok"),
    ) as unknown as Record<string | symbol, unknown>;
    fetchFn.proxyUrl = proxyUrl;
    fetchFn[Symbol.for("openclaw.proxyFetch.close")] = closeSpy;
    return fetchFn;
  }),
);

vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  makeProxyFetch: makeProxyFetchMock,
  PROXY_FETCH_CLOSE: Symbol.for("openclaw.proxyFetch.close"),
}));

describe("resolveZaloProxyFetch", () => {
  let resolveZaloProxyFetch: typeof import("./proxy.js").resolveZaloProxyFetch;
  const ZALO_PROXY_CACHE_MAX_ENTRIES = 64;

  beforeEach(async () => {
    vi.resetModules();
    makeProxyFetchMock.mockClear();
    closeSpy.mockClear();
    ({ resolveZaloProxyFetch } = await import("./proxy.js"));
  });

  it("returns undefined for empty or whitespace proxy URLs", () => {
    expect(resolveZaloProxyFetch(undefined)).toBeUndefined();
    expect(resolveZaloProxyFetch(null)).toBeUndefined();
    expect(resolveZaloProxyFetch("")).toBeUndefined();
    expect(resolveZaloProxyFetch("   ")).toBeUndefined();
    expect(makeProxyFetchMock).not.toHaveBeenCalled();
  });

  it("caches fetchers by trimmed proxy URL", () => {
    const first = resolveZaloProxyFetch(" http://proxy.example:8080 ");
    const second = resolveZaloProxyFetch("http://proxy.example:8080");
    expect(first).toBe(second);
    expect(makeProxyFetchMock).toHaveBeenCalledTimes(1);
    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://proxy.example:8080");
  });

  it("negative control: Map without prune retains oldest after 65 inserts", () => {
    // Pre-fix shape: process-lifetime Map with no eviction keeps every URL.
    const unbounded = new Map<string, ReturnType<typeof makeProxyFetchMock>>();
    const urls = Array.from(
      { length: ZALO_PROXY_CACHE_MAX_ENTRIES + 1 },
      (_, i) => `http://proxy-${i}.example:8080`,
    );
    for (const url of urls) {
      unbounded.set(url, makeProxyFetchMock(url));
    }
    expect(unbounded.size).toBe(ZALO_PROXY_CACHE_MAX_ENTRIES + 1);
    expect(unbounded.has(urls[0]!)).toBe(true);

    // Same insert sequence with pruneMapToMaxSize matches the production fix.
    const bounded = new Map<string, ReturnType<typeof makeProxyFetchMock>>();
    for (const url of urls) {
      bounded.set(url, makeProxyFetchMock(url));
      pruneMapToMaxSize(bounded, ZALO_PROXY_CACHE_MAX_ENTRIES);
    }
    expect(bounded.size).toBe(ZALO_PROXY_CACHE_MAX_ENTRIES);
    expect(bounded.has(urls[0]!)).toBe(false);
    expect(bounded.has(urls[1]!)).toBe(true);
    console.log(
      `[zalo proxyCache negative control] unbounded_size=${unbounded.size} unbounded_keeps_oldest=true bounded_size=${bounded.size} bounded_evicts_oldest=true`,
    );
  });

  it("evicts the oldest proxy fetcher when more than 64 distinct URLs are resolved", () => {
    const urls = Array.from(
      { length: ZALO_PROXY_CACHE_MAX_ENTRIES + 1 },
      (_, i) => `http://proxy-${i}.example:8080`,
    );

    const fetchers = urls.map((url) => resolveZaloProxyFetch(url));
    expect(makeProxyFetchMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 1);

    // Oldest URL was evicted: resolving it again rebuilds a fresh fetcher.
    const rebuilt = resolveZaloProxyFetch(urls[0]!);
    expect(rebuilt).not.toBe(fetchers[0]);
    expect(makeProxyFetchMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 2);

    // A mid-window entry still hits the cache.
    expect(resolveZaloProxyFetch(urls[2]!)).toBe(fetchers[2]);
    expect(makeProxyFetchMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 2);

    console.log(
      `[zalo proxyCache proof] max=${ZALO_PROXY_CACHE_MAX_ENTRIES} filled=${ZALO_PROXY_CACHE_MAX_ENTRIES + 1} oldest_evicted=true rebuilt=true mid_hit=true`,
    );
  });

  it("evicts an early entry when newer distinct proxies fill the cache", () => {
    const earlyUrl = "http://early.example:8080";
    const early = resolveZaloProxyFetch(earlyUrl);
    for (let i = 0; i < ZALO_PROXY_CACHE_MAX_ENTRIES; i += 1) {
      resolveZaloProxyFetch(`http://churn-${i}.example:8080`);
    }
    expect(resolveZaloProxyFetch(earlyUrl)).not.toBe(early);
    expect(makeProxyFetchMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 2);
  });

  it("closes the underlying ProxyAgent dispatcher on eviction", () => {
    // Fill the cache to 64 — no eviction yet, so no close call.
    for (let i = 0; i < ZALO_PROXY_CACHE_MAX_ENTRIES; i += 1) {
      resolveZaloProxyFetch(`http://proxy-${i}.example:8080`);
    }
    expect(closeSpy).not.toHaveBeenCalled();

    // The 65th insert triggers eviction of the oldest entry.
    resolveZaloProxyFetch(`http://proxy-65.example:8080`);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Every subsequent insert beyond the cap closes exactly one evicted dispatcher.
    for (let i = 0; i < 5; i += 1) {
      resolveZaloProxyFetch(`http://churn-${i}.example:8080`);
    }
    expect(closeSpy).toHaveBeenCalledTimes(6);
  });
});
