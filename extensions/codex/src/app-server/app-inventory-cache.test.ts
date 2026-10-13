// Codex tests cover app inventory cache plugin behavior.
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

describe("Codex app inventory cache", () => {
  it("coalesces native metadata and installed runtime facts without fabricating app/list fields", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const apps = [
      { ...app("app-1"), iconUrl: "https://example.com/app-icon.png" },
      { ...app("app-2"), name: "Canonical app name" },
    ];
    const installedApps = [
      { id: "app-1", runtimeName: null, enabled: true, callable: false },
      { id: "app-2", runtimeName: "runtime-name", enabled: false, callable: false },
    ];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params, { installedApps }),
    );

    const key = buildCodexAppInventoryCacheKey(
      { codexHome: "/codex", authProfileId: "work" },
      "2026.6.27",
      "2026.6.27",
    );
    const read = cache.read({ key, request, nowMs: 0 });
    expect(read.state).toBe("missing");
    expect(read.refreshScheduled).toBe(true);

    const snapshot = await cache.refreshNow({ key, request, nowMs: 0 });
    expect(snapshot.apps).toEqual(apps);
    expect(snapshot.installedApps).toEqual(installedApps);
    expect(request).toHaveBeenNthCalledWith(1, "app/installed", { forceRefresh: true });
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: ["app-1", "app-2"],
      includeTools: true,
    });

    const fresh = cache.read({ key, request, nowMs: 50 });
    expect(fresh.state).toBe("fresh");
    expect(fresh.refreshScheduled).toBe(false);
    expect(fresh.snapshot?.apps).toEqual(apps);
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
    cache.invalidate("runtime", "connector changed", Date.now(), [runtimeId]);
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

  it("upgrades an in-flight targeted refresh before returning the complete account inventory", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const apps = [app("google-calendar-app"), app("unrelated-slack-app")];
    let resolveTargetedInstall: ((response: v2.AppsInstalledResponse) => void) | undefined;
    let installedCalls = 0;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        installedCalls += 1;
        if (installedCalls === 1) {
          expect(params).toEqual({ forceRefresh: true });
          return await new Promise<v2.AppsInstalledResponse>((resolve) => {
            resolveTargetedInstall = resolve;
          });
        }
        expect(params).toEqual({ forceRefresh: false });
      }
      return codexAppInventoryResponse(method, apps, params);
    });

    const targeted = cache.refreshNow({
      key: "runtime",
      request,
      targetAppIds: ["google-calendar-app"],
    });
    const complete = cache.refreshNow({ key: "runtime", request, targetAppIds: [] });
    expect(installedCalls).toBe(1);

    resolveTargetedInstall?.(codexAppInventoryResponse("app/installed", apps));
    const [targetedSnapshot, completeSnapshot] = await Promise.all([targeted, complete]);

    expect(targetedSnapshot.apps).toEqual([app("google-calendar-app")]);
    expect(completeSnapshot.apps).toEqual(apps);
    expect(cache.read({ key: "runtime", request }).snapshot?.apps).toEqual(apps);
    expect(request.mock.calls.filter(([method]) => method === "app/installed")).toEqual([
      ["app/installed", { forceRefresh: true }],
      ["app/installed", { forceRefresh: false }],
    ]);
    expect(request.mock.calls.filter(([method]) => method === "app/read")).toEqual([
      ["app/read", { appIds: ["google-calendar-app"], includeTools: true }],
      ["app/read", { appIds: ["google-calendar-app", "unrelated-slack-app"], includeTools: true }],
    ]);
  });

  it("joins a complete in-flight refresh for a narrower plugin request", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const apps = [app("google-calendar-app"), app("unrelated-slack-app")];
    let resolveInstall: ((response: v2.AppsInstalledResponse) => void) | undefined;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        return await new Promise<v2.AppsInstalledResponse>((resolve) => {
          resolveInstall = resolve;
        });
      }
      return codexAppInventoryResponse(method, apps, params);
    });

    const complete = cache.refreshNow({ key: "runtime", request, targetAppIds: [] });
    const targeted = cache.refreshNow({
      key: "runtime",
      request,
      targetAppIds: ["google-calendar-app"],
    });
    resolveInstall?.(codexAppInventoryResponse("app/installed", apps));

    const [completeSnapshot, targetedSnapshot] = await Promise.all([complete, targeted]);
    expect(completeSnapshot.apps).toEqual(apps);
    expect(targetedSnapshot.apps).toEqual(apps);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("limits each metadata request to the app/read 100-app contract", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const apps = Array.from({ length: 205 }, (_, index) => app(`app-${index}`));
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    const snapshot = await cache.refreshNow({ key: "runtime", request });

    expect(snapshot.apps).toEqual(apps);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenNthCalledWith(2, "app/read", {
      appIds: apps.slice(0, 100).map((entry) => entry.id),
      includeTools: true,
    });
    expect(request).toHaveBeenNthCalledWith(3, "app/read", {
      appIds: apps.slice(100, 200).map((entry) => entry.id),
      includeTools: true,
    });
    expect(request).toHaveBeenNthCalledWith(4, "app/read", {
      appIds: apps.slice(200).map((entry) => entry.id),
      includeTools: true,
    });
  });

  it("excludes installed apps whose metadata is missing", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
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
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, [app("app-overflow")], params),
    );
    const key = "runtime";
    const snapshot = await cache.refreshNow({ key, request, nowMs: MAX_DATE_TIMESTAMP_MS });

    expect(snapshot.expiresAtMs).toBe(0);
    const read = cache.read({
      key,
      request,
      nowMs: Date.parse("2026-05-29T12:00:00.000Z"),
    });
    expect(read.state).toBe("stale");
    expect(read.snapshot?.apps).toEqual([app("app-overflow")]);
  });

  it("records refresh errors without discarding the last successful snapshot", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1 });
    const key = "runtime";
    await cache.refreshNow({
      key,
      nowMs: 0,
      request: async (method, params) => codexAppInventoryResponse(method, [app("app-1")], params),
    });

    await expect(
      cache.refreshNow({
        key,
        nowMs: 2,
        request: async () => {
          throw new Error("app inventory failed");
        },
      }),
    ).rejects.toThrow("app inventory failed");

    const read = cache.read({
      key,
      nowMs: 2,
      request: async (method, params) => codexAppInventoryResponse(method, [app("app-2")], params),
    });
    expect(read.snapshot?.apps).toEqual([app("app-1")]);
    expect(read.diagnostic?.message).toBe("app inventory failed");
  });

  it("fails closed when the pinned server does not implement app/installed", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        throw new CodexAppServerRpcError({ code: -32601, message: "Method not found" }, method);
      }
      return codexAppInventoryResponse(method, [app("current-app")], params);
    });

    await expect(cache.refreshNow({ key: "runtime", request })).rejects.toThrow("Method not found");
    expect(request).toHaveBeenCalledExactlyOnceWith("app/installed", { forceRefresh: true });
    expect(cache.read({ key: "runtime", request, suppressRefresh: true }).snapshot).toBeUndefined();
  });

  it("fails closed when installed app inventory is unauthorized", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
    const request = vi.fn(async (method) => {
      throw new CodexAppServerRpcError({ code: 403, message: "Forbidden" }, method);
    });

    await expect(cache.refreshNow({ key: "runtime", request })).rejects.toThrow("Forbidden");
    expect(request).toHaveBeenCalledExactlyOnceWith("app/installed", { forceRefresh: true });
  });

  it("fails closed when app metadata cannot be read", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 100 });
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

  it.each(["clear", "invalidate", "forced successor"] as const)(
    "keeps an obsolete refresh rejection out of cache state after %s",
    async (replacement) => {
      const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
      const key = "runtime";
      const deferred = Promise.withResolvers<never>();
      const failure = new Error("obsolete inventory refresh failed");
      const request = vi.fn(async (method, params) =>
        codexAppInventoryResponse(method, [app("fresh-app")], params),
      );
      const obsolete = cache.refreshNow({ key, request: () => deferred.promise, nowMs: 0 });
      const obsoleteRejection = expect(obsolete).rejects.toBe(failure);

      if (replacement === "clear") {
        cache.clear();
      } else if (replacement === "invalidate") {
        cache.invalidate(key, "apps changed", 1);
      } else {
        await cache.refreshNow({ key, request, nowMs: 2, forceRefetch: true });
      }
      deferred.reject(failure);
      await obsoleteRejection;

      const current = cache.read({ key, request, nowMs: 3, suppressRefresh: true });
      expect(current.state).toBe(replacement === "forced successor" ? "fresh" : "missing");
      expect(current.diagnostic).toEqual(
        replacement === "invalidate" ? { message: "apps changed", atMs: 1 } : undefined,
      );
      if (replacement === "forced successor") {
        expect(current.snapshot?.apps).toEqual([app("fresh-app")]);
        expect(current.snapshot?.lastError).toBeUndefined();
      } else {
        expect(current.snapshot).toBeUndefined();
      }
    },
  );

  it("forces a post-install refresh past an older in-flight runtime snapshot", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    let resolveStale: ((response: v2.AppsInstalledResponse) => void) | undefined;
    let resolveFresh: ((response: v2.AppsInstalledResponse) => void) | undefined;
    let installedCalls = 0;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        installedCalls += 1;
        expect(params.forceRefresh).toBe(true);
        return await new Promise<v2.AppsInstalledResponse>((resolve) => {
          if (installedCalls === 1) {
            resolveStale = resolve;
          } else {
            resolveFresh = resolve;
          }
        });
      }
      return codexAppInventoryResponse(method, [app("fresh-app"), app("stale-app")], params);
    });

    const staleRead = cache.read({ key, request, nowMs: 0 });
    expect(staleRead.state).toBe("missing");
    expect(staleRead.refreshScheduled).toBe(true);

    cache.invalidate(key, "plugin installed", 1);
    const forcedRead = cache.read({ key, request, nowMs: 1, forceRefetch: true });
    expect(forcedRead.state).toBe("missing");
    expect(forcedRead.refreshScheduled).toBe(true);
    expect(installedCalls).toBe(2);

    const forced = cache.refreshNow({ key, request, nowMs: 1 });
    resolveFresh?.(codexAppInventoryResponse("app/installed", [app("fresh-app")]));
    await expect(forced).resolves.toStrictEqual({
      key,
      apps: [app("fresh-app")],
      installedApps: [{ id: "fresh-app", runtimeName: "fresh-app", enabled: true, callable: true }],
      fetchedAtMs: 1,
      expiresAtMs: 1_001,
      revision: 2,
    });

    resolveStale?.(codexAppInventoryResponse("app/installed", [app("stale-app")]));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));

    const freshRead = cache.read({ key, request, nowMs: 2 });
    expect(freshRead.state).toBe("fresh");
    expect(freshRead.snapshot?.apps).toEqual([app("fresh-app")]);
  });

  it("does not republish a pre-clear refresh over the new inventory", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const staleInstalled = Promise.withResolvers<v2.AppsInstalledResponse>();
    const apps = [app("fresh-app"), app("stale-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );
    request.mockImplementationOnce(() => staleInstalled.promise);

    const stale = cache.refreshNow({ key: "runtime", request, nowMs: 0 });
    cache.clear();
    await cache.refreshNow({
      key: "runtime",
      request,
      nowMs: 1,
      targetAppIds: ["fresh-app"],
    });
    staleInstalled.resolve(codexAppInventoryResponse("app/installed", [app("stale-app")]));
    await stale;

    const read = cache.read({ key: "runtime", request, nowMs: 2, suppressRefresh: true });
    expect(read.state).toBe("fresh");
    expect(read.snapshot?.apps).toEqual([app("fresh-app")]);
  });

  it("discards a pre-invalidation refresh instead of republishing it as fresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    let resolveInstalled: ((response: v2.AppsInstalledResponse) => void) | undefined;
    const request = vi.fn(async (method, params) => {
      if (method === "app/installed") {
        return await new Promise<v2.AppsInstalledResponse>((resolve) => {
          resolveInstalled = resolve;
        });
      }
      return codexAppInventoryResponse(method, [app("stale-app")], params);
    });

    const read = cache.read({ key, request, nowMs: 0 });
    expect(read.state).toBe("missing");
    expect(read.refreshScheduled).toBe(true);

    cache.invalidate(key, "plugin installed", 1);
    resolveInstalled?.(codexAppInventoryResponse("app/installed", [app("stale-app")]));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    const after = cache.read({ key, request, nowMs: 2, suppressRefresh: true });
    expect(after.state).toBe("missing");
    expect(after.diagnostic?.message).toBe("plugin installed");
  });

  it("does not renew non-target row freshness during a targeted merge", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: [] });
    await cache.refreshNow({
      key,
      request,
      nowMs: 900,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });

    // Freshness still belongs to the complete fetch at t=0, not the merge at t=900.
    const read = cache.read({ key, request, nowMs: 1_100, suppressRefresh: true });
    expect(read.state).toBe("stale");
  });

  it("merges targeted refreshes for one runtime instead of alternating narrow snapshots", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: ["calendar-app"] });
    await cache.refreshNow({
      key,
      request,
      nowMs: 1,
      forceRefetch: true,
      targetAppIds: ["drive-app"],
    });

    const read = cache.read({ key, request, nowMs: 2, suppressRefresh: true });
    expect(read.state).toBe("fresh");
    expect(read.snapshot?.targetAppIds).toEqual(["calendar-app", "drive-app"]);
    expect(read.snapshot?.apps).toEqual(apps);
    expect(read.snapshot?.installedApps.map((entry) => entry.id)).toEqual([
      "calendar-app",
      "drive-app",
    ]);
  });

  it("replaces an expired union entry on the next single-target refresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: ["calendar-app"] });
    await cache.refreshNow({
      key,
      request,
      nowMs: 1,
      forceRefetch: true,
      targetAppIds: ["drive-app"],
    });
    expect(cache.read({ key, request, nowMs: 1_500, suppressRefresh: true }).state).toBe("stale");

    // Past TTL nothing is preserved; the single-target refresh replaces the
    // union entry and freshness recovers without a complete fetch.
    await cache.refreshNow({
      key,
      request,
      nowMs: 1_500,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    const read = cache.read({ key, request, nowMs: 1_600, suppressRefresh: true });
    expect(read.state).toBe("fresh");
    expect(read.snapshot?.targetAppIds).toEqual(["calendar-app"]);
    expect(read.snapshot?.apps).toEqual([app("calendar-app")]);
  });

  it("retires stacked scoped invalidations across separate covering refreshes", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app"), app("drive-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: [] });
    cache.invalidate(key, "calendar plugin installed", 1, ["calendar-app"]);
    cache.invalidate(key, "drive plugin installed", 2, ["drive-app"]);

    await cache.refreshNow({
      key,
      request,
      nowMs: 3,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    expect(cache.read({ key, request, nowMs: 4, suppressRefresh: true }).state).toBe("stale");

    await cache.refreshNow({
      key,
      request,
      nowMs: 5,
      forceRefetch: true,
      targetAppIds: ["drive-app"],
    });
    expect(cache.read({ key, request, nowMs: 6, suppressRefresh: true }).state).toBe("fresh");
  });

  it("keeps an unscoped invalidation until a complete refresh", async () => {
    const cache = new CodexAppInventoryCache({ ttlMs: 1_000 });
    const key = "runtime";
    const apps = [app("calendar-app")];
    const request = vi.fn(async (method, params) =>
      codexAppInventoryResponse(method, apps, params),
    );

    await cache.refreshNow({ key, request, nowMs: 0, targetAppIds: [] });
    cache.invalidate(key, "runtime identity changed", 1);

    await cache.refreshNow({
      key,
      request,
      nowMs: 2,
      forceRefetch: true,
      targetAppIds: ["calendar-app"],
    });
    expect(cache.read({ key, request, nowMs: 3, suppressRefresh: true }).state).toBe("stale");

    await cache.refreshNow({ key, request, nowMs: 4, forceRefetch: true, targetAppIds: [] });
    expect(cache.read({ key, request, nowMs: 5, suppressRefresh: true }).state).toBe("fresh");
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
