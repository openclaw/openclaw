// Codex tests cover plugin metadata cache behavior.
import { describe, expect, it, vi } from "vitest";
import { pluginList as catalog, pluginSummary } from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { v2 } from "./protocol.js";

describe("Codex plugin metadata cache", () => {
  it("coalesces installed plugins through the canonical endpoint", async () => {
    const cache = new CodexPluginMetadataCache();
    let release: ((response: v2.PluginInstalledResponse) => void) | undefined;
    const request = vi.fn(
      async () =>
        await new Promise<v2.PluginInstalledResponse>((resolve) => {
          release = resolve;
        }),
    );
    const requestParams = { cwds: ["/workspace/a"] } satisfies v2.PluginInstalledParams;
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "installed" as const,
      requestParams,
      request,
    };

    const first = cache.load(params);
    const second = cache.load(params);
    expect(request).toHaveBeenCalledExactlyOnceWith("plugin/installed", requestParams);
    const response = installedPlugins("workspace-directory", "calendar");
    release?.(response);

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    expect(firstSnapshot).toBe(secondSnapshot);
    expect(firstSnapshot).toBe(response);
    expect(cache.read("runtime-a", "installed", requestParams)).toBe(firstSnapshot);
    expect(cache.read("runtime-a", "installed")).toBeUndefined();
    await expect(cache.load(params)).resolves.toBe(firstSnapshot);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("isolates partial catalog snapshots by the marketplace being resolved", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi
      .fn<() => Promise<v2.PluginListResponse>>()
      .mockResolvedValueOnce(pluginList("company-tools", "security-review"))
      .mockResolvedValueOnce(pluginList("openai-curated-remote", "calendar"));
    const requestParams = { cwds: ["/workspace/a"] };

    const company = await cache.load({
      appCacheKey: "runtime",
      queryKind: "curated-global",
      requestParams,
      catalogScope: "company-tools",
      request,
    });
    const curated = await cache.load({
      appCacheKey: "runtime",
      queryKind: "curated-global",
      requestParams,
      request,
    });

    expect(company.marketplaces[0]?.name).toBe("company-tools");
    expect(curated.marketplaces[0]?.name).toBe("openai-curated-remote");
    expect(request).toHaveBeenCalledTimes(2);
    expect(cache.read("runtime", "curated-global", requestParams, "company-tools")).toBe(company);
    expect(cache.read("runtime", "curated-global", requestParams)).toBe(curated);
  });

  it("expires settled snapshots after the freshness window", async () => {
    // Upstream refreshes its remote catalog in the background; a settled
    // negative must not deny a configured plugin for the process lifetime.
    let now = 0;
    const cache = new CodexPluginMetadataCache(() => now);
    const request = vi.fn(async () => pluginList("openai-curated-remote", "calendar"));
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "curated-global" as const,
      requestParams: {},
      request,
    };

    await cache.load(params);
    await cache.load(params);
    expect(request).toHaveBeenCalledTimes(1);
    now = 60 * 60 * 1_000 + 1;
    expect(cache.read("runtime-a", "curated-global")).toBeUndefined();
    await cache.load(params);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares a failed load without retrying for every waiting caller", async () => {
    const cache = new CodexPluginMetadataCache();
    let rejectOwner: ((error: Error) => void) | undefined;
    const ownerRequest = vi.fn(
      async () =>
        await new Promise<v2.PluginListResponse>((_resolve, reject) => {
          rejectOwner = reject;
        }),
    );
    const params = {
      appCacheKey: "runtime-a",
      queryKind: "curated-global" as const,
      requestParams: {},
    };
    const owner = cache.load({ ...params, request: ownerRequest });
    const ownerResult = owner.catch((error: unknown) => error);
    const joiningRequest = vi.fn(async () => pluginList("openai-curated-remote", "calendar"));
    const joining = cache.load({ ...params, request: joiningRequest });
    const joiningResult = joining.catch((error: unknown) => error);

    const error = new Error("owner cancelled");
    rejectOwner?.(error);
    await expect(ownerResult).resolves.toBe(error);
    await expect(joiningResult).resolves.toBe(error);
    expect(ownerRequest).toHaveBeenCalledTimes(1);
    expect(joiningRequest).not.toHaveBeenCalled();

    await expect(cache.load({ ...params, request: joiningRequest })).resolves.toMatchObject({
      marketplaces: [{ plugins: [{ id: "calendar" }] }],
    });
    expect(joiningRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps an unrelated runtime load cacheable across invalidation", async () => {
    const cache = new CodexPluginMetadataCache();
    let release: ((response: v2.PluginListResponse) => void) | undefined;
    const request = vi.fn(
      async () =>
        await new Promise<v2.PluginListResponse>((resolve) => {
          release = resolve;
        }),
    );
    const params = {
      appCacheKey: "runtime-b",
      queryKind: "curated-global" as const,
      requestParams: {},
      request,
    };
    const pending = cache.load(params);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    cache.invalidate("runtime-a");
    const response = pluginList("openai-curated-remote", "calendar");
    release?.(response);
    await pending;

    await expect(cache.load(params)).resolves.toMatchObject(response);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("invalidates one runtime and clear resets all snapshots", async () => {
    const cache = new CodexPluginMetadataCache();
    const request = vi.fn(async () => pluginList("openai-curated-remote"));
    const load = (appCacheKey: string) =>
      cache.load({
        appCacheKey,
        queryKind: "curated-global",
        requestParams: {},
        request,
      });

    await load("runtime-a");
    await load("runtime-b");
    cache.invalidate("runtime-a");
    await load("runtime-a");
    await load("runtime-b");
    expect(request).toHaveBeenCalledTimes(3);

    cache.clear();
    expect(cache.read("runtime-a", "curated-global")).toBeUndefined();
    expect(cache.read("runtime-b", "curated-global")).toBeUndefined();
  });
});

function pluginList(marketplaceName: string, pluginId?: string): v2.PluginListResponse {
  return catalog(pluginId ? [pluginSummary(pluginId)] : [], { name: marketplaceName, path: null });
}

function installedPlugins(marketplaceName: string, pluginId?: string): v2.PluginInstalledResponse {
  const { marketplaces } = pluginList(marketplaceName, pluginId);
  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      plugin.installed = true;
      plugin.enabled = true;
    }
  }
  return {
    marketplaces,
    marketplaceLoadErrors: [],
  };
}
