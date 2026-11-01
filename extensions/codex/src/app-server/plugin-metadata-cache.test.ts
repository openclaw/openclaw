import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pluginInstalled,
  pluginList as catalog,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { v2 } from "./protocol.js";

describe("Codex plugin metadata cache", () => {
  let cache: CodexPluginMetadataCache;
  const catalogParams = {
    appCacheKey: "runtime-a",
    queryKind: "curated-global",
    requestParams: {},
  } as const;
  beforeEach(() => {
    cache = new CodexPluginMetadataCache();
  });

  it("coalesces installed plugins through the canonical endpoint", async () => {
    const deferred = Promise.withResolvers<v2.PluginInstalledResponse>();
    const request = vi.fn(() => deferred.promise);
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
    const response = pluginInstalled(
      [pluginSummary("calendar", { installed: true, enabled: true })],
      { name: "workspace-directory", path: null },
    );
    deferred.resolve(response);

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    expect(firstSnapshot).toBe(secondSnapshot);
    expect(firstSnapshot).toBe(response);
    expect(cache.read("runtime-a", "installed", requestParams)).toBe(firstSnapshot);
    expect(cache.read("runtime-a", "installed")).toBeUndefined();
    await expect(cache.load(params)).resolves.toBe(firstSnapshot);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("isolates partial catalog snapshots by the marketplace being resolved", async () => {
    const request = vi
      .fn<() => Promise<v2.PluginListResponse>>()
      .mockResolvedValueOnce(pluginList("company-tools", "security-review"))
      .mockResolvedValueOnce(pluginList("openai-curated-remote", "calendar"));
    const requestParams = { cwds: ["/workspace/a"] };

    const params = { ...catalogParams, appCacheKey: "runtime", requestParams, request };
    const company = await cache.load({ ...params, catalogScope: "company-tools" });
    const curated = await cache.load(params);

    expect(company.marketplaces[0]?.name).toBe("company-tools");
    expect(curated.marketplaces[0]?.name).toBe("openai-curated-remote");
    expect(request).toHaveBeenCalledTimes(2);
    expect(cache.read("runtime", "curated-global", requestParams, "company-tools")).toBe(company);
    expect(cache.read("runtime", "curated-global", requestParams)).toBe(curated);
  });

  it("expires settled snapshots after the freshness window", async () => {
    // Upstream refreshes its remote catalog in the background; a settled
    // negative must not deny a configured plugin for the process lifetime.
    using now = vi.spyOn(Date, "now").mockReturnValue(0);
    const request = vi.fn(async () => pluginList("openai-curated-remote", "calendar"));
    const params = { ...catalogParams, request };

    await cache.load(params);
    await cache.load(params);
    expect(request).toHaveBeenCalledTimes(1);
    now.mockReturnValue(60 * 60 * 1_000 + 1);
    expect(cache.read("runtime-a", "curated-global")).toBeUndefined();
    await cache.load(params);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares a failed load without retrying for every waiting caller", async () => {
    const deferred = Promise.withResolvers<v2.PluginListResponse>();
    const ownerRequest = vi.fn(() => deferred.promise);
    const params = catalogParams;
    const owner = cache.load({ ...params, request: ownerRequest });
    const ownerResult = owner.catch((error: unknown) => error);
    const joiningRequest = vi.fn(async () => pluginList("openai-curated-remote", "calendar"));
    const joining = cache.load({ ...params, request: joiningRequest });
    const joiningResult = joining.catch((error: unknown) => error);

    const error = new Error("owner cancelled");
    deferred.reject(error);
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
    const deferred = Promise.withResolvers<v2.PluginListResponse>();
    const request = vi.fn(() => deferred.promise);
    const params = { ...catalogParams, appCacheKey: "runtime-b", request };
    const pending = cache.load(params);
    expect(request).toHaveBeenCalledTimes(1);

    cache.invalidate("runtime-a");
    const response = pluginList("openai-curated-remote", "calendar");
    deferred.resolve(response);
    await pending;

    await expect(cache.load(params)).resolves.toMatchObject(response);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("invalidates one runtime and clear resets all snapshots", async () => {
    const request = vi.fn(async () => pluginList("openai-curated-remote"));
    const load = (appCacheKey: string) => cache.load({ ...catalogParams, appCacheKey, request });

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
