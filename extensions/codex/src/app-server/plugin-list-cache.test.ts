// Codex tests cover plugin list cache behavior.
import { describe, expect, it, vi } from "vitest";
import { CodexPluginListCache, CODEX_PLUGIN_LIST_CACHE_TTL_MS } from "./plugin-list-cache.js";
import type { v2 } from "./protocol.js";

describe("Codex plugin list cache", () => {
  it("returns missing on first read and refreshes on demand", async () => {
    const cache = new CodexPluginListCache({ ttlMs: 100 });
    const request = vi.fn(async () => pluginListResponse());
    const read = cache.read({ key: "runtime" });
    expect(read.state).toBe("missing");
    expect(read.snapshot).toBeUndefined();

    const snapshot = await cache.refreshNow({ key: "runtime", request, nowMs: 0 });
    expect(snapshot.response.marketplaces).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);

    const fresh = cache.read({ key: "runtime", nowMs: 50 });
    expect(fresh.state).toBe("fresh");
    expect(fresh.snapshot?.response).toStrictEqual(snapshot.response);
  });

  it("returns a fresh snapshot from readOrRefresh without extra calls", async () => {
    const cache = new CodexPluginListCache({ ttlMs: 100 });
    const request = vi.fn(async () => pluginListResponse());
    const first = await cache.readOrRefresh({ key: "runtime", request, nowMs: 0 });
    expect(first.response.marketplaces).toHaveLength(1);

    const second = await cache.readOrRefresh({ key: "runtime", request, nowMs: 50 });
    expect(second).toStrictEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refreshes when stale on readOrRefresh", async () => {
    const cache = new CodexPluginListCache({ ttlMs: 10 });
    let callCount = 0;
    const request = vi.fn(async () => {
      callCount += 1;
      return pluginListResponse([pluginSummary(`plugin-${callCount}`)]);
    });
    await cache.readOrRefresh({ key: "runtime", request, nowMs: 0 });
    const refreshed = await cache.readOrRefresh({ key: "runtime", request, nowMs: 15 });
    expect(refreshed.response.marketplaces[0]?.plugins[0]?.id).toBe("plugin-2");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("forces refetch when forceRefetch is true", async () => {
    const cache = new CodexPluginListCache({ ttlMs: 1_000 });
    let callCount = 0;
    const request = vi.fn(async () => {
      callCount += 1;
      return pluginListResponse([pluginSummary(`plugin-${callCount}`)]);
    });
    await cache.readOrRefresh({ key: "runtime", request, nowMs: 0 });
    expect(request).toHaveBeenCalledTimes(1);

    const forced = await cache.readOrRefresh({
      key: "runtime",
      request,
      nowMs: 1,
      forceRefetch: true,
    });
    expect(forced.response.marketplaces[0]?.plugins[0]?.id).toBe("plugin-2");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("marks entries stale after invalidation", async () => {
    const cache = new CodexPluginListCache({ ttlMs: 1_000 });
    const request = vi.fn(async () => pluginListResponse());
    await cache.refreshNow({ key: "runtime", request, nowMs: 0 });

    cache.invalidate("runtime", "plugin installed", 10);
    const read = cache.read({ key: "runtime", nowMs: 15 });
    expect(read.state).toBe("stale");
  });

  it("coalesces concurrent refreshes for the same key", async () => {
    const cache = new CodexPluginListCache({ ttlMs: 100 });
    let resolveFirst: ((response: v2.PluginListResponse) => void) | undefined;
    const request = vi.fn(
      async (): Promise<v2.PluginListResponse> =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const first = cache.refreshNow({ key: "runtime", request, nowMs: 0 });
    const second = cache.refreshNow({ key: "runtime", request, nowMs: 0 });
    expect(request).toHaveBeenCalledTimes(1);

    resolveFirst?.(pluginListResponse());
    const firstResult = await first;
    const secondResult = await second;
    // Both callers receive the same coalesced snapshot.
    expect(secondResult).toStrictEqual(firstResult);
  });

  it("prevents an older refresh from overwriting a newer snapshot", async () => {
    const cache = new CodexPluginListCache({ ttlMs: 1_000 });
    let resolveStale: ((response: v2.PluginListResponse) => void) | undefined;
    let resolveFresh: ((response: v2.PluginListResponse) => void) | undefined;
    const request = vi.fn(async (): Promise<v2.PluginListResponse> => {
      return new Promise((resolve) => {
        if (request.mock.calls.length === 1) {
          resolveStale = resolve;
        } else {
          resolveFresh = resolve;
        }
      });
    });

    const stalePromise = cache.refreshNow({ key: "runtime", request, nowMs: 0 });
    const freshPromise = cache.refreshNow({
      key: "runtime",
      request,
      nowMs: 1,
      forceRefetch: true,
    });

    resolveFresh?.(pluginListResponse([pluginSummary("fresh-plugin")]));
    await expect(freshPromise).resolves.toMatchObject({
      response: { marketplaces: expect.arrayContaining([expect.anything()]) },
    });

    resolveStale?.(pluginListResponse([pluginSummary("stale-plugin")]));
    await stalePromise.catch(() => undefined);

    const read = cache.read({ key: "runtime", nowMs: 2 });
    expect(read.snapshot?.response.marketplaces[0]?.plugins[0]?.id).toBe("fresh-plugin");
  });

  it("clears all entries", async () => {
    const cache = new CodexPluginListCache({ ttlMs: 100 });
    const request = vi.fn(async () => pluginListResponse());
    await cache.refreshNow({ key: "key-a", request, nowMs: 0 });
    await cache.refreshNow({ key: "key-b", request, nowMs: 0 });
    expect(cache.getRevision()).toBeGreaterThan(0);

    cache.clear();
    expect(cache.getRevision()).toBe(0);
    expect(cache.read({ key: "key-a" }).state).toBe("missing");
    expect(cache.read({ key: "key-b" }).state).toBe("missing");
  });

  it("uses the default TTL when not overridden", () => {
    const cache = new CodexPluginListCache();
    // The default TTL is 5 minutes; we verify it's not zero or undefined.
    expect(CODEX_PLUGIN_LIST_CACHE_TTL_MS).toBe(5 * 60 * 1_000);
    expect(cache.getRevision()).toBe(0);
  });

  it("propagates refresh errors", async () => {
    const cache = new CodexPluginListCache({ ttlMs: 100 });
    const request = vi.fn(async () => {
      throw new Error("plugin list failed");
    });
    await expect(cache.readOrRefresh({ key: "runtime", request, nowMs: 0 })).rejects.toThrow(
      "plugin list failed",
    );
    expect(cache.read({ key: "runtime" }).state).toBe("missing");
  });
});

function pluginListResponse(
  plugins: v2.PluginSummary[] = [pluginSummary("google-calendar")],
): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name: "openai-curated",
        path: "/marketplaces/openai-curated",
        interface: null,
        plugins,
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function pluginSummary(id: string): v2.PluginSummary {
  return {
    id,
    name: id,
    source: { type: "remote" },
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    interface: null,
  };
}
