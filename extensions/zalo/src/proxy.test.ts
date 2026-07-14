import { beforeEach, describe, expect, it, vi } from "vitest";

const closeSpy = vi.hoisted(() => vi.fn(async () => undefined));
const createHttp1ProxyAgentMock = vi.hoisted(() =>
  vi.fn((_options: { uri: string }) => ({
    close: closeSpy,
  })),
);
const fetchWithRuntimeDispatcherMock = vi.hoisted(() => vi.fn(async () => new Response("ok")));

vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  createHttp1ProxyAgent: createHttp1ProxyAgentMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-fetch", () => ({
  fetchWithRuntimeDispatcher: fetchWithRuntimeDispatcherMock,
}));

describe("resolveZaloProxyFetch", () => {
  let resolveZaloProxyFetch: typeof import("./proxy.js").resolveZaloProxyFetch;
  let acquireZaloProxyFetch: typeof import("./proxy.js").acquireZaloProxyFetch;
  let releaseZaloProxyFetch: typeof import("./proxy.js").releaseZaloProxyFetch;
  const ZALO_PROXY_CACHE_MAX_ENTRIES = 64;

  beforeEach(async () => {
    vi.resetModules();
    createHttp1ProxyAgentMock.mockClear();
    closeSpy.mockClear();
    fetchWithRuntimeDispatcherMock.mockClear();
    ({ resolveZaloProxyFetch, acquireZaloProxyFetch, releaseZaloProxyFetch } =
      await import("./proxy.js"));
  });

  it("returns undefined for empty or whitespace proxy URLs", () => {
    expect(resolveZaloProxyFetch(undefined)).toBeUndefined();
    expect(resolveZaloProxyFetch(null)).toBeUndefined();
    expect(resolveZaloProxyFetch("")).toBeUndefined();
    expect(resolveZaloProxyFetch("   ")).toBeUndefined();
    expect(createHttp1ProxyAgentMock).not.toHaveBeenCalled();
  });

  it("caches fetchers by trimmed proxy URL", () => {
    const first = resolveZaloProxyFetch(" http://proxy.example:8080 ");
    const second = resolveZaloProxyFetch("http://proxy.example:8080");
    expect(first).toBe(second);
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(1);
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledWith({
      uri: "http://proxy.example:8080",
    });
  });

  it("negative control: Map without bound retains oldest after 65 inserts", () => {
    const unbounded = new Map<string, object>();
    const urls = Array.from(
      { length: ZALO_PROXY_CACHE_MAX_ENTRIES + 1 },
      (_, i) => `http://proxy-${i}.example:8080`,
    );
    for (const url of urls) {
      unbounded.set(url, { url });
    }
    expect(unbounded.size).toBe(ZALO_PROXY_CACHE_MAX_ENTRIES + 1);
    expect(unbounded.has(urls[0]!)).toBe(true);
    console.log(
      `[zalo proxyCache negative control] unbounded_size=${unbounded.size} unbounded_keeps_oldest=true`,
    );
  });

  it("evicts the oldest proxy fetcher when more than 64 distinct URLs are resolved", () => {
    const urls = Array.from(
      { length: ZALO_PROXY_CACHE_MAX_ENTRIES + 1 },
      (_, i) => `http://proxy-${i}.example:8080`,
    );

    const fetchers = urls.map((url) => resolveZaloProxyFetch(url));
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 1);

    const rebuilt = resolveZaloProxyFetch(urls[0]!);
    expect(rebuilt).not.toBe(fetchers[0]);
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 2);
    expect(resolveZaloProxyFetch(urls[2]!)).toBe(fetchers[2]);
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 2);

    console.log(
      `[zalo proxyCache proof] max=${ZALO_PROXY_CACHE_MAX_ENTRIES} filled=${ZALO_PROXY_CACHE_MAX_ENTRIES + 1} oldest_evicted=true rebuilt=true mid_hit=true`,
    );
  });

  it("closes the underlying ProxyAgent dispatcher on unused eviction", () => {
    for (let i = 0; i < ZALO_PROXY_CACHE_MAX_ENTRIES; i += 1) {
      resolveZaloProxyFetch(`http://proxy-${i}.example:8080`);
    }
    expect(closeSpy).not.toHaveBeenCalled();
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES);

    resolveZaloProxyFetch(`http://proxy-65.example:8080`);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // One closed + one created keeps live agents at the cap.
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 1);

    for (let i = 0; i < 5; i += 1) {
      resolveZaloProxyFetch(`http://churn-${i}.example:8080`);
    }
    expect(closeSpy).toHaveBeenCalledTimes(6);
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 6);
  });

  it("retained evicted fetcher fails closed and does not recreate a dispatcher", async () => {
    const urls = Array.from(
      { length: ZALO_PROXY_CACHE_MAX_ENTRIES + 1 },
      (_, i) => `http://proxy-${i}.example:8080`,
    );
    const retained = resolveZaloProxyFetch(urls[0]!);
    for (const url of urls.slice(1)) {
      resolveZaloProxyFetch(url);
    }
    expect(closeSpy).toHaveBeenCalledTimes(1);
    const agentsBefore = createHttp1ProxyAgentMock.mock.calls.length;

    await expect(retained!("http://example.invalid", { method: "HEAD" })).rejects.toThrow(
      /disposed/,
    );
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(agentsBefore);
    expect(fetchWithRuntimeDispatcherMock).not.toHaveBeenCalled();
    console.log(
      `[zalo proxyCache retained-evicted] agents_before=${agentsBefore} agents_after=${createHttp1ProxyAgentMock.mock.calls.length} recreate=false fail_closed=true`,
    );
  });

  it("defers dispose for leased monitor fetchers until release", () => {
    const urls = Array.from(
      { length: ZALO_PROXY_CACHE_MAX_ENTRIES },
      (_, i) => `http://leased-${i}.example:8080`,
    );
    for (const url of urls) {
      acquireZaloProxyFetch(url);
    }
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES);
    expect(closeSpy).not.toHaveBeenCalled();

    resolveZaloProxyFetch("http://extra.example:8080");
    expect(closeSpy).not.toHaveBeenCalled();
    expect(createHttp1ProxyAgentMock).toHaveBeenCalledTimes(ZALO_PROXY_CACHE_MAX_ENTRIES + 1);

    releaseZaloProxyFetch(urls[0]!);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
