// Codex tests cover plugin activation plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { CodexAppServerRpcError } from "./client.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
  type ResolvedCodexPluginPolicy,
} from "./config.js";
import { ensureCodexPluginActivation } from "./plugin-activation.js";
import { pluginList, pluginSummary } from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { v2 } from "./protocol.js";

const installed = { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
const remoteMarketplace = { name: "openai-curated-remote", path: null };
const localInstall = {
  marketplacePath: "/marketplaces/openai-curated",
  pluginName: "google-calendar",
};
const remoteInstall = {
  remoteMarketplaceName: remoteMarketplace.name,
  pluginName: "plugin_connector_google_calendar",
};
const active = () =>
  pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
const remote = (overrides: Partial<v2.PluginSummary> = {}) =>
  pluginSummary("google-calendar@openai-curated-remote", {
    name: "google-calendar",
    remotePluginId: remoteInstall.pluginName,
    ...overrides,
  });
function identity(pluginName = "google-calendar"): ResolvedCodexPluginPolicy {
  return {
    configKey: pluginName,
    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    pluginName,
    enabled: true,
    allowDestructiveActions: false,
    destructiveApprovalMode: "deny",
  };
}
type ActivationParams = Parameters<typeof ensureCodexPluginActivation>[0];
type Handler = (params: unknown) => unknown;
function harness(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request: ActivationParams["request"] = async (method, params) => {
    calls.push({ method, params });
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`unexpected request ${method}`);
    }
    return handler(params);
  };
  return {
    calls,
    activate: (params: Partial<ActivationParams> = {}) =>
      ensureCodexPluginActivation({ identity: identity(), request, ...params }),
  };
}
function expectResult(
  result: Awaited<ReturnType<typeof ensureCodexPluginActivation>>,
  ok: boolean,
  reason: string,
  installAttempted = false,
) {
  expect(result).toMatchObject({ ok, reason, installAttempted });
}
const install = (expected: typeof localInstall | typeof remoteInstall) => (params: unknown) => {
  expect(params).toEqual(expected);
  return installed;
};

describe("Codex plugin activation", () => {
  it("skips plugin/install when the migrated plugin is already active", async () => {
    const h = harness({ "plugin/list": active });
    expectResult(await h.activate(), true, "already_active");
    expect(h.calls.map(({ method }) => method)).toEqual(["plugin/list"]);
  });

  it("can reinstall an already active plugin when migration explicitly applies it", async () => {
    const h = harness({ "plugin/list": active, "plugin/install": install(localInstall) });
    expectResult(await h.activate({ installEvenIfActive: true }), true, "already_active", true);
    expect(h.calls.map(({ method }) => method)).toEqual([
      "plugin/list",
      "plugin/install",
      "plugin/list",
    ]);
  });

  it("installs a migration-authorized local curated plugin and refreshes runtime state", async () => {
    const metadataCache = new CodexPluginMetadataCache();
    let lists = 0;
    const h = harness({
      "plugin/list": (params) => {
        expect(params).toEqual(++lists === 1 ? {} : { forceRefetch: true });
        return pluginList([
          pluginSummary("google-calendar", { installed: lists > 1, enabled: lists > 1 }),
        ]);
      },
      "plugin/install": install(localInstall),
      "app/installed": (params) => {
        expect(params).toMatchObject({ forceRefresh: true });
        return { apps: [] } satisfies v2.AppsInstalledResponse;
      },
    });
    expectResult(
      await h.activate({
        appCache: new CodexAppInventoryCache(),
        appCacheKey: "runtime",
        metadataCache,
      }),
      true,
      "installed",
      true,
    );
    expect(h.calls.map(({ method }) => method)).toEqual([
      "plugin/list",
      "plugin/install",
      "plugin/list",
      "app/installed",
    ]);
    expect(lists).toBe(2);
    expect(
      metadataCache.read("runtime", "curated-global")?.marketplaces[0]?.plugins[0],
    ).toMatchObject({ installed: true, enabled: true });
  });

  it("keeps curated catalog refresh scoped to the active repository", async () => {
    let lists = 0;
    const h = harness({
      "plugin/list": () => {
        lists++;
        return pluginList([
          pluginSummary("google-calendar", { installed: lists > 1, enabled: lists > 1 }),
        ]);
      },
      "plugin/install": () => installed,
    });
    expectResult(await h.activate({ configCwd: "/repo/project" }), true, "installed", true);
    expect(h.calls).toContainEqual({ method: "plugin/list", params: { cwds: ["/repo/project"] } });
    expect(h.calls).toContainEqual({
      method: "plugin/list",
      params: { cwds: ["/repo/project"], forceRefetch: true },
    });
  });

  it("keeps activation fail-closed when post-install app inventory refresh fails", async () => {
    const h = harness({
      "plugin/list": () => pluginList([pluginSummary("google-calendar")]),
      "plugin/install": () => installed,
      "app/installed": () => {
        throw new Error("app/installed unavailable");
      },
    });
    const result = await h.activate({
      appCache: new CodexAppInventoryCache(),
      appCacheKey: "runtime",
    });
    expectResult(result, true, "installed", true);
    expect(result.diagnostics).toEqual([
      { message: "Codex app inventory refresh skipped: app/installed unavailable" },
    ]);
  });

  it("installs a disabled remote curated plugin by its resolved remote id", async () => {
    const remoteList = pluginList([remote()], remoteMarketplace);
    const h = harness({
      "plugin/list": () => ({
        ...remoteList,
        marketplaces: [
          ...pluginList([pluginSummary("github")]).marketplaces,
          ...remoteList.marketplaces,
        ],
      }),
      "plugin/install": install(remoteInstall),
    });
    expectResult(await h.activate(), true, "installed", true);
    expect(h.calls.map(({ method }) => method)).toEqual([
      "plugin/list",
      "plugin/install",
      "plugin/list",
    ]);
  });

  it("converts an exact terminal remote plugin rejection into an activation failure", async () => {
    const message = "remote plugin plugin_connector_google_calendar is not available for install";
    const h = harness({
      "plugin/list": () => pluginList([remote()], remoteMarketplace),
      "plugin/install": (params) => {
        expect(params).toEqual(remoteInstall);
        throw new CodexAppServerRpcError({ code: -32600, message }, "plugin/install");
      },
    });
    const result = await h.activate();
    expectResult(result, false, "install_failed", true);
    expect(result.diagnostics).toEqual([{ message: `Codex plugin install failed: ${message}` }]);
    expect(h.calls.map(({ method }) => method)).toEqual(["plugin/list", "plugin/install"]);
  });

  it("does not hide unrelated plugin install RPC failures", async () => {
    const error = new CodexAppServerRpcError(
      { code: -32600, message: "plugin service temporarily unavailable" },
      "plugin/install",
    );
    const h = harness({
      "plugin/list": () => pluginList([remote()], remoteMarketplace),
      "plugin/install": () => {
        throw error;
      },
    });
    await expect(h.activate()).rejects.toBe(error);
  });

  it.each([
    { availability: "DISABLED_BY_ADMIN", installPolicy: "AVAILABLE" },
    { availability: "AVAILABLE", installPolicy: "NOT_AVAILABLE" },
  ] as const)("never installs a curated plugin rejected by marketplace policy", async (policy) => {
    const h = harness({ "plugin/list": () => pluginList([remote(policy)], remoteMarketplace) });
    expectResult(await h.activate(), false, "disabled");
    expect(h.calls.map(({ method }) => method)).toEqual(["plugin/list"]);
  });

  it("does not install a remote curated plugin without its opaque remote id", async () => {
    const h = harness({
      "plugin/list": () =>
        pluginList(
          [pluginSummary("google-calendar@openai-curated-remote", { name: "google-calendar" })],
          remoteMarketplace,
        ),
    });
    const result = await h.activate();
    expectResult(result, false, "plugin_missing");
    expect(h.calls.map(({ method }) => method)).toEqual(["plugin/list"]);
    expect(result.diagnostics[0]?.message).toContain("did not return a remote plugin id");
  });

  it("settles a missing plugin from the remote curated marketplace snapshot", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => {
      expect(params).toEqual({});
      return pluginList([], remoteMarketplace);
    });
    const params = {
      identity: identity(),
      request,
      metadataCache: new CodexPluginMetadataCache(),
      appCacheKey: "runtime",
    };
    expect((await ensureCodexPluginActivation(params)).reason).toBe("plugin_missing");
    expect((await ensureCodexPluginActivation(params)).reason).toBe("plugin_missing");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("requires workspace-directory plugins to be activated outside OpenClaw", async () => {
    const h = harness({});
    const result = await h.activate({
      identity: {
        ...identity("workspace-data@workspace-directory"),
        marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
      },
    });
    expectResult(result, false, "disabled");
    expect(result.diagnostics[0]?.message).toContain("installed and enabled outside OpenClaw");
    expect(h.calls).toEqual([]);
  });

  it("never installs a non-curated plugin during thread startup", async () => {
    const h = harness({});
    const result = await h.activate({
      identity: { ...identity("security-review"), marketplaceName: "openai-bundled" },
      configCwd: "/repo/company",
    });
    expectResult(result, false, "disabled");
    expect(result.diagnostics[0]?.message).toContain(
      "/codex plugins install security-review@openai-bundled",
    );
    expect(h.calls).toEqual([]);
  });
});
