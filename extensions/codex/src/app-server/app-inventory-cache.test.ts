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
    cache.invalidate("runtime", "connector changed");
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
