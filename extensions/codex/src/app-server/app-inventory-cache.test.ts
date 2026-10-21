import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppInventoryCache,
  buildCodexAppInventoryCacheKey,
  serializeCodexAppInventoryError,
} from "./app-inventory-cache.js";
import { CodexAppServerRpcError } from "./client.js";
import type { CodexAppServerRequestParams, CodexAppServerRequestResult, v2 } from "./protocol.js";

type AppMetadata = CodexAppServerRequestResult<"app/read">["apps"][number];
const CACHE_TTL_MS = 60 * 60 * 1_000;

function inventory(
  apps = [app("app-1")],
  options?: Parameters<typeof codexAppInventoryResponse>[3],
) {
  const cache = new CodexAppInventoryCache();
  const request = vi.fn(async (method, params) =>
    codexAppInventoryResponse(method, apps, params, options),
  );
  const key = "runtime";
  type Options = Omit<Parameters<typeof cache.refreshNow>[0], "key" | "request">;
  return {
    cache,
    request,
    refresh: (overrides: Options = {}) => cache.refreshNow({ key, request, ...overrides }),
    read: (overrides: Options = {}) => cache.read({ key, request, ...overrides }),
  };
}

function pendingInventory() {
  const apps = [app("google-calendar-app"), app("unrelated-slack-app")];
  const fixture = inventory(apps);
  const gate = Promise.withResolvers<void>();
  let installedCalls = 0;
  fixture.request.mockImplementation(async (method, params) => {
    if (method === "app/installed" && ++installedCalls === 1) {
      await gate.promise;
    }
    return codexAppInventoryResponse(method, apps, params);
  });
  return { ...fixture, apps, release: () => gate.resolve() };
}

describe("Codex app inventory cache", () => {
  it.each([false, true, undefined])(
    "preserves cold-cache refresh intent %s across independent thread keys",
    async (forceRefetch) => {
      const apps = [app("app-1")];
      const { cache, request } = inventory(apps);

      for (const key of ["thread-a", "thread-b"]) {
        const snapshot = await cache.refreshNow({ key, request, forceRefetch });
        expect(snapshot.apps).toEqual(apps);
      }
      expect(request.mock.calls.filter(([method]) => method === "app/installed")).toEqual([
        ["app/installed", { forceRefresh: forceRefetch !== false }],
        ["app/installed", { forceRefresh: forceRefetch !== false }],
      ]);
    },
  );

  it("coalesces native metadata and installed runtime facts without fabricating app/list fields", async () => {
    const apps = [
      { ...app("app-1"), iconUrl: "https://example.com/app-icon.png" },
      { ...app("app-2"), name: "Canonical app name" },
    ];
    const installedApps = [
      { id: "app-1", runtimeName: null, enabled: true, callable: false },
      { id: "app-2", runtimeName: "runtime-name", enabled: false, callable: false },
    ];
    const { cache, request } = inventory(apps, { installedApps });

    const key = buildCodexAppInventoryCacheKey(
      { codexHome: "/codex", authProfileId: "work" },
      "2026.6.27",
      "2026.6.27",
    );
    const read = cache.read({ key, request, nowMs: 0 });
    expect(read.state).toBe("missing");
    expect(request).toHaveBeenCalledTimes(1);

    const snapshot = await cache.refreshNow({ key, request, nowMs: 0 });
    expect([snapshot.apps, snapshot.installedApps]).toEqual([apps, installedApps]);
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: ["app-1", "app-2"],
      includeTools: true,
    });

    const fresh = cache.read({ key, request, nowMs: 50 });
    expect([fresh.state, fresh.snapshot?.apps]).toEqual(["fresh", apps]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refreshes and removes legacy runtime rows targeted by their Apps SDK identity", async () => {
    const manifestId = "asdk_app_0123456789abcdef0123456789abcdef";
    const runtimeId = "connector_0123456789abcdef0123456789abcdef";
    const cache = new CodexAppInventoryCache();
    let apps = [app(runtimeId), app("unrelated")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );
    await cache.refreshNow({ key: "runtime", request });
    cache.invalidate("runtime");
    await cache.refreshNow({ key: "runtime", request, targetAppIds: [manifestId] });
    expect(cache.read({ key: "runtime", request, suppressRefresh: true })).toMatchObject({
      state: "fresh",
      snapshot: { apps },
    });
    apps = [app("unrelated")];
    await cache.refreshNow({ key: "runtime", request, targetAppIds: [manifestId] });
    const refreshed = cache.read({ key: "runtime", request, suppressRefresh: true }).snapshot;
    expect(refreshed?.apps).toEqual(apps);
    expect(refreshed?.installedApps.map((entry) => entry.id)).toEqual(["unrelated"]);
  });

  it.each([true, false])(
    "coalesces overlapping inventory reads (targeted first: %s)",
    async (targetedFirst) => {
      const { read, refresh, request, apps, release } = pendingInventory();
      const narrow = ["google-calendar-app"];
      const first = refresh({ targetAppIds: targetedFirst ? narrow : [] });
      const second = refresh({ targetAppIds: targetedFirst ? [] : narrow });
      expect(request).toHaveBeenCalledTimes(1);
      release();
      const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

      expect(firstSnapshot.apps).toEqual(targetedFirst ? [apps[0]] : apps);
      expect(secondSnapshot.apps).toEqual(apps);
      expect(read().snapshot?.apps).toEqual(apps);
      const coldRead = ["app/installed", { forceRefresh: true }];
      const completeRead = [
        "app/read",
        { appIds: ["google-calendar-app", "unrelated-slack-app"], includeTools: true },
      ];
      expect(request.mock.calls).toEqual(
        targetedFirst
          ? [
              coldRead,
              ["app/read", { appIds: narrow, includeTools: true }],
              ["app/installed", { forceRefresh: false }],
              completeRead,
            ]
          : [coldRead, completeRead],
      );
    },
  );

  it("limits each metadata request to the app/read 100-app contract", async () => {
    const apps = Array.from({ length: 205 }, (_, index) => app(`app-${index}`));
    const { refresh, request } = inventory(apps);
    expect((await refresh()).apps).toEqual(apps);
    expect(request).toHaveBeenCalledTimes(4);
    for (const [index, start] of [0, 100, 200].entries()) {
      expect(request).toHaveBeenNthCalledWith(index + 2, "app/read", {
        appIds: apps.slice(start, start + 100).map((entry) => entry.id),
        includeTools: true,
      });
    }
  });

  it("excludes installed apps whose metadata is missing", async () => {
    const cache = new CodexAppInventoryCache();
    const installedApps = [app("available-app"), app("missing-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(
        method,
        method === "app/read" ? [installedApps[0]!] : installedApps,
        params,
      ),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual([app("available-app")]);
    expect(snapshot.installedApps.map((entry) => entry.id)).toEqual([
      "available-app",
      "missing-app",
    ]);
  });

  it("marks inventory stale when the expiry would exceed the Date range", async () => {
    const { refresh, read } = inventory([app("app-overflow")]);
    const snapshot = await refresh({ nowMs: MAX_DATE_TIMESTAMP_MS });

    expect(snapshot.expiresAtMs).toBe(0);
    const stale = read({ nowMs: Date.parse("2026-05-29T12:00:00.000Z") });
    expect([stale.state, stale.snapshot?.apps]).toEqual(["stale", [app("app-overflow")]]);
  });

  it("fails closed when app metadata cannot be read", async () => {
    const cache = new CodexAppInventoryCache();
    const request = vi.fn(async (method, params) => {
      if (method === "app/read") {
        throw new CodexAppServerRpcError({ code: -32601, message: "Method not found" }, method);
      }
      return codexAppInventoryResponse(method, [app("current-app")], params);
    });

    await expect(cache.refreshNow({ key: "runtime", request })).rejects.toThrow("Method not found");
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: ["current-app"],
      includeTools: true,
    });
    expect(cache.read({ key: "runtime", request, suppressRefresh: true }).snapshot).toBeUndefined();
  });

  it("omits challenge HTML when serializing app inventory errors", () => {
    const error = new Error(
      'failed to read apps: Request failed with status 403 Forbidden: <html><script src="/backend-api/connectors/directory/list?__cf_chl_tk=secret-token"></script></html>',
    );

    expect(serializeCodexAppInventoryError(error).message).toBe(
      "failed to read apps: Request failed with status 403 Forbidden: [HTML response body omitted]",
    );
  });

  it("keeps serialized app inventory error data on a UTF-16 boundary", () => {
    const error = Object.assign(new Error("app inventory failed"), {
      data: { label: `${"x".repeat(499)}🚀tail` },
    });

    expect(serializeCodexAppInventoryError(error).data).toEqual({
      label: `${"x".repeat(499)}...`,
    });
  });

  it("does not renew non-target row freshness during a targeted merge", async () => {
    const { refresh, read } = inventory([app("calendar-app"), app("drive-app")]);

    await refresh({ nowMs: 0, targetAppIds: [] });
    await refresh({
      nowMs: CACHE_TTL_MS - 100,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });

    // Freshness still belongs to the complete fetch, not the near-expiry merge.
    expect(read({ nowMs: CACHE_TTL_MS + 100, suppressRefresh: true }).state).toBe("stale");
  });

  it("replaces an expired union entry on the next single-target refresh", async () => {
    const { refresh, read } = inventory([app("calendar-app"), app("drive-app")]);

    await refresh({ nowMs: 0, targetAppIds: ["calendar-app"] });
    await refresh({
      nowMs: 1,
      forceRefetch: true,
      targetAppIds: ["drive-app"],
    });
    await refresh({
      nowMs: CACHE_TTL_MS + 500,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    const fresh = read({ nowMs: CACHE_TTL_MS + 600, suppressRefresh: true });
    expect([fresh.state, fresh.snapshot?.targetAppIds, fresh.snapshot?.apps]).toEqual([
      "fresh",
      ["calendar-app"],
      [app("calendar-app")],
    ]);
  });
});

function app(id: string): AppMetadata {
  return {
    id,
    name: id,
    description: null,
    iconUrl: null,
    iconUrlDark: null,
    distributionChannel: null,
    installUrl: null,
    pluginDisplayNames: [],
    toolSummaries: null,
  };
}

function codexAppInventoryResponse<Method extends "app/installed" | "app/read">(
  method: Method,
  apps: readonly AppMetadata[],
  params?: CodexAppServerRequestParams<Method>,
  options?: {
    installedApps?: readonly v2.InstalledApp[];
    callableByAppId?: Readonly<Record<string, boolean>>;
  },
): CodexAppServerRequestResult<Method> {
  if (method === "app/installed") {
    return {
      apps:
        options?.installedApps ??
        apps.map((metadata) => ({
          id: metadata.id,
          runtimeName: metadata.name,
          enabled: true,
          callable: options?.callableByAppId?.[metadata.id] ?? true,
        })),
    } as CodexAppServerRequestResult<Method>;
  }
  const requestedIds = (params as CodexAppServerRequestParams<"app/read"> | undefined)?.appIds;
  const matchingApps = apps.filter(
    (metadata) => !requestedIds || requestedIds.includes(metadata.id),
  );
  return {
    apps: matchingApps,
    missingAppIds:
      requestedIds?.filter((id) => !matchingApps.some((metadata) => metadata.id === id)) ?? [],
  } as CodexAppServerRequestResult<Method>;
}
