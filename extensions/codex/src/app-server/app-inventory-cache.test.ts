import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache, buildCodexAppInventoryCacheKey } from "./app-inventory-cache.js";
import type { v2 } from "./protocol-generated/typescript/index.js";

describe("Codex app inventory cache", () => {
  it("returns missing while scheduling one coalesced app/list refresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (_method: "app/list", params: v2.AppsListParams) => {
      return {
        data: [app(params.cursor ? "app-2" : "app-1")],
        nextCursor: params.cursor ? null : "next",
      } satisfies v2.AppsListResponse;
    });

    const key = buildCodexAppInventoryCacheKey({ codexHome: "/codex", authProfileId: "work" });
    const read = cache.read({ key, request, nowMs: 0 });
    expect(read.state).toBe("missing");
    expect(read.refreshScheduled).toBe(true);

    const snapshot = await cache.refreshNow({ key, request, nowMs: 0 });
    expect(snapshot.apps.map((item) => item.id)).toEqual(["app-1", "app-2"]);
    expect(request).toHaveBeenCalledTimes(2);

    const fresh = cache.read({ key, request, nowMs: 50 });
    expect(fresh.state).toBe("fresh");
    expect(fresh.refreshScheduled).toBe(false);
    expect(fresh.snapshot?.apps.map((item) => item.id)).toEqual(["app-1", "app-2"]);
  });

  it("uses stale inventory for the current read while refreshing asynchronously", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 10 });
    const request = vi.fn(async () => {
      return {
        data: [app(`app-${request.mock.calls.length}`)],
        nextCursor: null,
      } satisfies v2.AppsListResponse;
    });
    const key = "runtime";
    await cache.refreshNow({ key, request, nowMs: 0 });

    const stale = cache.read({ key, request, nowMs: 11 });
    expect(stale.state).toBe("stale");
    expect(stale.snapshot?.apps.map((item) => item.id)).toEqual(["app-1"]);
    expect(stale.refreshScheduled).toBe(true);

    const refreshed = await cache.refreshNow({ key, request, nowMs: 11 });
    expect(refreshed.apps.map((item) => item.id)).toEqual(["app-2"]);
  });

  it("records refresh errors without discarding the last successful snapshot", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1 });
    const key = "runtime";
    await cache.refreshNow({
      key,
      nowMs: 0,
      request: async () => ({ data: [app("app-1")], nextCursor: null }),
    });

    await expect(
      cache.refreshNow({
        key,
        nowMs: 2,
        request: async () => {
          throw new Error("app list failed");
        },
      }),
    ).rejects.toThrow("app list failed");

    const read = cache.read({
      key,
      nowMs: 2,
      request: async () => ({ data: [app("app-2")], nextCursor: null }),
    });
    expect(read.snapshot?.apps.map((item) => item.id)).toEqual(["app-1"]);
    expect(read.diagnostic?.message).toBe("app list failed");
  });
});

function app(id: string): v2.AppInfo {
  return {
    id,
    name: id,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
  };
}
