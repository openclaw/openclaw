// Zalo production-path proof: real createHttp1ProxyAgent-backed fetchers.
import { beforeEach, describe, expect, it } from "vitest";

/** Matches `PROXY_FETCH_PROXY_URL` / Zalo local tag (plugin-boundary safe). */
const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");

describe("resolveZaloProxyFetch production-path proof", () => {
  const ZALO_PROXY_CACHE_MAX_ENTRIES = 64;

  beforeEach(async () => {
    const { resetZaloProxyCacheForTests } = await import("./proxy.js");
    resetZaloProxyCacheForTests();
  });

  it("bounds real ProxyAgent-backed fetchers and fails closed after eviction", async () => {
    const { resolveZaloProxyFetch, getZaloProxyLiveDispatcherCount } = await import("./proxy.js");
    const urls = Array.from(
      { length: ZALO_PROXY_CACHE_MAX_ENTRIES + 1 },
      (_, i) => `http://127.0.0.1:${19_000 + i}`,
    );

    const fetchers = urls.map((url) => resolveZaloProxyFetch(url));
    expect(getZaloProxyLiveDispatcherCount()).toBe(ZALO_PROXY_CACHE_MAX_ENTRIES);

    const tagged = fetchers[0] as
      | ({
          [PROXY_FETCH_PROXY_URL]?: string;
        } & (typeof fetchers)[0])
      | undefined;
    expect(tagged?.[PROXY_FETCH_PROXY_URL]).toBe(urls[0]);

    await expect(fetchers[0]!("http://127.0.0.1:1", { method: "HEAD" })).rejects.toThrow(
      /disposed/,
    );

    const rebuilt = resolveZaloProxyFetch(urls[0]!);
    expect(rebuilt).not.toBe(fetchers[0]);
    expect(resolveZaloProxyFetch(urls[2]!)).toBe(fetchers[2]);
    expect(getZaloProxyLiveDispatcherCount()).toBe(ZALO_PROXY_CACHE_MAX_ENTRIES);

    console.log(
      `[zalo proxyCache production proof] max=${ZALO_PROXY_CACHE_MAX_ENTRIES} filled=${urls.length} live_dispatchers=${getZaloProxyLiveDispatcherCount()} oldest_evicted=true retained_fail_closed=true mid_hit=true`,
    );
  });
});
