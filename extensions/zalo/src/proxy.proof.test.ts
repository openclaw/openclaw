// Zalo production-path proof: real makeProxyFetch / Undici ProxyAgent wrappers.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Matches `PROXY_FETCH_PROXY_URL` in `src/infra/net/proxy-fetch.ts` (plugin-boundary safe). */
const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");

describe("resolveZaloProxyFetch production-path proof", () => {
  const ZALO_PROXY_CACHE_MAX_ENTRIES = 64;

  beforeEach(() => {
    vi.resetModules();
  });

  it("bounds real ProxyAgent-backed fetchers and rebuilds after oldest eviction", async () => {
    const { resolveZaloProxyFetch } = await import("./proxy.js");
    const urls = Array.from(
      { length: ZALO_PROXY_CACHE_MAX_ENTRIES + 1 },
      (_, i) => `http://127.0.0.1:${19_000 + i}`,
    );

    const fetchers = urls.map((url) => resolveZaloProxyFetch(url));
    expect(fetchers.every((fetcher) => typeof fetcher === "function")).toBe(true);
    expect(fetchers[0]).not.toBe(fetchers[1]);
    const tagged = fetchers[0] as
      | ((typeof fetchers)[0] & {
          [PROXY_FETCH_PROXY_URL]?: string;
        })
      | undefined;
    expect(tagged?.[PROXY_FETCH_PROXY_URL]).toBe(urls[0]);

    const rebuilt = resolveZaloProxyFetch(urls[0]!);
    expect(rebuilt).not.toBe(fetchers[0]);
    expect(resolveZaloProxyFetch(urls[2]!)).toBe(fetchers[2]);

    console.log(
      `[zalo proxyCache production proof] max=${ZALO_PROXY_CACHE_MAX_ENTRIES} filled=${urls.length} oldest_evicted=true rebuilt=true mid_hit=true real_makeProxyFetch=true`,
    );
  });
});
