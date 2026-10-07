// Codex tests cover plugin inventory plugin behavior.
import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
} from "./config.js";
import { readCodexPluginInventory, toCodexPluginOwnedAccountApp } from "./plugin-inventory.js";
import {
  appInfo,
  appSummary,
  asPluginInstalled,
  pluginDetail,
  pluginInstalled,
  pluginList,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { v2 } from "./protocol.js";

describe("Codex plugin inventory", () => {
  it("returns enabled migrated curated plugins with stable owned app ids", async () => {
    const appCache = await cachedApps(appInfo("google-calendar-app", true));
    const calls: string[] = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
        slack: curatedPlugin("slack", { enabled: false }),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        calls.push(method);
        if (method === "plugin/installed") {
          return pluginInstalled([activePlugin("google-calendar"), activePlugin("slack")]);
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "google-calendar",
          });
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toHaveLength(1);
    const record = inventory.records[0];
    expect(record?.policy.pluginName).toBe("google-calendar");
    expect(record?.summary.installed).toBe(true);
    expect(record?.summary.enabled).toBe(true);
    expect(record?.appOwnership).toBe("proven");
    expect(record?.ownedAppIds).toStrictEqual(["google-calendar-app"]);
    expect(record?.apps).toStrictEqual([
      {
        id: "google-calendar-app",
        name: "google-calendar-app",
        accessible: true,
      },
    ]);
    expect(calls).toEqual(["plugin/installed", "plugin/read"]);
  });

  it("reuses one installed snapshot for consecutive configured plugin inventories", async () => {
    const metadataCache = new CodexPluginMetadataCache();
    const calls: Array<{ method: string; params: unknown }> = [];
    const params = {
      pluginConfig: pluginConfig({ github: curatedPlugin("github") }),
      appCacheKey: "runtime",
      configCwd: "/repo/project",
      metadataCache,
      request: async (method: string, requestParams?: unknown) => {
        calls.push({ method, params: requestParams });
        if (method === "plugin/installed") {
          return pluginInstalled([activePlugin("github")]);
        }
        if (method === "plugin/read") {
          return pluginDetail("github", []);
        }
        throw new Error(`unexpected request ${method}`);
      },
    };

    const first = await readCodexPluginInventory(params);
    const second = await readCodexPluginInventory(params);

    expect(first.records[0]?.summary.id).toBe("github");
    expect(second.records[0]?.summary.id).toBe("github");
    expect(calls).toEqual([
      { method: "plugin/installed", params: { cwds: ["/repo/project"] } },
      ...Array.from({ length: 2 }, () => ({
        method: "plugin/read",
        params: { marketplacePath: "/marketplaces/openai-curated", pluginName: "github" },
      })),
    ]);
  });

  it("reads the curated catalog only for an explicitly requested missing plugin", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({ calendar: curatedPlugin("calendar") }),
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/installed") {
          return pluginInstalled([]);
        }
        if (method === "plugin/list") {
          return pluginList([pluginSummary("calendar")]);
        }
        if (method === "plugin/read") {
          return pluginDetail("calendar", []);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toEqual([
      { method: "plugin/installed", params: {} },
      { method: "plugin/list", params: {} },
      {
        method: "plugin/read",
        params: { marketplacePath: "/marketplaces/openai-curated", pluginName: "calendar" },
      },
    ]);
    expect(inventory.records[0]).toMatchObject({
      activationRequired: true,
      summary: { id: "calendar", installed: false },
    });
  });

  it("matches namespaced curated plugin ids by normalized path segment", async () => {
    const appCache = await cachedApps(appInfo("github-app", true));

    const listed = pluginList([
      activePlugin("openai-curated/github", {
        name: "GitHub",
      }),
    ]);
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({ github: curatedPlugin("github") }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        if (method === "plugin/installed") {
          return asPluginInstalled(listed);
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "github",
          });
          return pluginDetail("github", [appSummary("github-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toHaveLength(1);
    const record = inventory.records[0];
    expect(record?.policy.pluginName).toBe("github");
    expect(record?.summary.id).toBe("openai-curated/github");
    expect(record?.summary.installed).toBe(true);
    expect(record?.summary.enabled).toBe(true);
    expect(record?.appOwnership).toBe("proven");
    expect(record?.ownedAppIds).toStrictEqual(["github-app"]);
    expect(inventory.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "plugin_missing",
    );
  });

  it("resolves an installed workspace plugin from the one canonical installed snapshot", async () => {
    const appCache = await cachedApps(appInfo("workspace-data-app", true));
    const calls: Array<{ method: string; params: unknown }> = [];
    const exactSummary = activePlugin("workspace-data@workspace-directory", {
      name: "Workspace Data",
      remotePluginId: "plugin_workspace_data",
    });

    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        workspaceData: workspacePlugin("workspace-data@workspace-directory"),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/installed") {
          return pluginInstalled(
            [
              activePlugin("other-workspace-data@workspace-directory", {
                name: "Workspace Data",
                remotePluginId: "wrong-workspace-data-id",
              }),
              exactSummary,
            ],
            { name: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, path: null },
          );
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            remoteMarketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
            pluginName: "plugin_workspace_data",
          });
          return pluginDetail("workspace-data", [appSummary("workspace-data-app")], {
            marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
            marketplacePath: null,
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls[0]).toStrictEqual({ method: "plugin/installed", params: {} });
    expect(calls.map((call) => call.method)).not.toContain("plugin/list");
    expect(inventory.records[0]?.summary).toBe(exactSummary);
    expect(inventory.records[0]?.ownedAppIds).toStrictEqual(["workspace-data-app"]);
    expect(inventory.diagnostics).toStrictEqual([]);
  });

  it("fails closed before plugin/read when a workspace summary lacks remotePluginId", async () => {
    const calls: string[] = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        workspaceData: workspacePlugin("workspace-data@workspace-directory"),
      }),
      request: async (method) => {
        calls.push(method);
        if (method === "plugin/installed") {
          return pluginInstalled(
            [
              activePlugin("workspace-data@workspace-directory", {
                name: "Workspace Data",
              }),
            ],
            { name: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, path: null },
          );
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toStrictEqual(["plugin/installed"]);
    expect(inventory.records[0]?.detail).toBeUndefined();
    expect(inventory.diagnostics.map((diagnostic) => diagnostic.code)).toStrictEqual([
      "plugin_detail_unavailable",
    ]);
  });

  it("diagnoses every missing workspace owner from the canonical installed snapshot", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        github: curatedPlugin("github"),
        workspaceData: workspacePlugin("workspace-data@workspace-directory"),
        workspaceMetrics: workspacePlugin("workspace-metrics@workspace-directory"),
      }),
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/read") {
          return pluginDetail("github", []);
        }
        if (method !== "plugin/installed") {
          throw new Error(`unexpected request ${method}`);
        }
        return pluginInstalled([activePlugin("github")]);
      },
    });

    expect(calls).toStrictEqual([
      { method: "plugin/installed", params: {} },
      {
        method: "plugin/read",
        params: { marketplacePath: "/marketplaces/openai-curated", pluginName: "github" },
      },
    ]);
    expect(inventory.records.map((record) => record.policy.configKey)).toStrictEqual(["github"]);
    expect(
      inventory.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        configKey: diagnostic.plugin?.configKey,
        message: diagnostic.message,
      })),
    ).toStrictEqual([
      {
        code: "marketplace_missing",
        configKey: "workspaceData",
        message: "Codex marketplace workspace-directory was not found.",
      },
      {
        code: "marketplace_missing",
        configKey: "workspaceMetrics",
        message: "Codex marketplace workspace-directory was not found.",
      },
    ]);
  });

  it("requires authorized metadata for an installed plugin app", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method) =>
        codexAppInventoryResponse(
          method,
          method === "app/installed" ? [appInfo("google-calendar-app", true)] : [],
        ),
    });
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/installed") {
          return pluginInstalled([activePlugin("google-calendar")]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    const record = inventory.records[0];
    expect(record?.appOwnership).toBe("proven");
    expect(record?.ownedAppIds).toStrictEqual(["google-calendar-app"]);
    expect(record?.apps).toStrictEqual([
      {
        id: "google-calendar-app",
        name: "google-calendar-app",
        accessible: false,
      },
    ]);
  });

  it("marks display-name-only app matches ambiguous instead of exposing app ids", async () => {
    const appCache = await cachedApps({
      ...appInfo("calendar-app", true),
      pluginDisplayNames: ["Google Calendar"],
    });

    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/installed") {
          return pluginInstalled([
            activePlugin("google-calendar", {
              name: "Google Calendar",
            }),
          ]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", []);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records[0]?.appOwnership).toBe("ambiguous");
    expect(inventory.records[0]?.ownedAppIds).toStrictEqual([]);
    expect(inventory.diagnostics.map((diagnostic) => diagnostic.code)).toStrictEqual([
      "app_ownership_ambiguous",
    ]);
  });

  it("fails closed when the app inventory cache is missing", async () => {
    const appCache = new CodexAppInventoryCache();
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      appCache,
      appCacheKey: "runtime",
      request: async (method) => {
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, []);
        }
        if (method === "plugin/installed") {
          return pluginInstalled([activePlugin("google-calendar")]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.appInventory?.state).toBe("missing");
    expect(inventory.records[0]?.ownedAppIds).toEqual(["google-calendar-app"]);
    expect(inventory.records[0]?.apps).toStrictEqual([]);
    expect(inventory.diagnostics.map((diagnostic) => diagnostic.code)).toStrictEqual([
      "app_inventory_missing",
    ]);
  });
});

type ConfiguredPlugin = {
  enabled?: boolean;
  marketplaceName:
    | typeof CODEX_PLUGINS_MARKETPLACE_NAME
    | typeof CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME;
  pluginName: string;
};

function pluginConfig(plugins: Record<string, ConfiguredPlugin>) {
  return { codexPlugins: { enabled: true, plugins } };
}

function curatedPlugin(pluginName: string, options: { enabled?: boolean } = {}): ConfiguredPlugin {
  return { marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME, pluginName, ...options };
}

function workspacePlugin(pluginName: string): ConfiguredPlugin {
  return { marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, pluginName };
}

async function cachedApps(...apps: v2.AppInfo[]): Promise<CodexAppInventoryCache> {
  const cache = new CodexAppInventoryCache();
  await cache.refreshNow({
    key: "runtime",
    nowMs: 0,
    request: async (method, params) => codexAppInventoryResponse(method, apps, params),
  });
  return cache;
}

function activePlugin(id: string, overrides: Partial<v2.PluginSummary> = {}): v2.PluginSummary {
  return pluginSummary(id, { installed: true, enabled: true, ...overrides });
}

function configuredPlugin(
  marketplaceName: string,
  pluginName: string,
  configKey = `${pluginName}@${marketplaceName}`,
) {
  return {
    codexPlugins: {
      enabled: true,
      plugins: { [configKey]: { marketplaceName, pluginName } },
    },
  };
}

describe("Codex marketplace-qualified plugin inventory", () => {
  it("never admits the same plugin name from a different marketplace", async () => {
    const inventory = await readCodexPluginInventory({
      pluginConfig: configuredPlugin("trusted-company", "audit"),
      configCwd: "/repo/company",
      request: async (method, params) => {
        expect(params).toEqual({ cwds: ["/repo/company"] });
        if (method === "plugin/installed" || method === "plugin/list") {
          const marketplace = {
            name: "untrusted-company",
            path: "/repo/untrusted/.agents/plugins/marketplace.json",
            interface: null,
            plugins: [pluginSummary("audit", { installed: true, enabled: true })],
          };
          return method === "plugin/installed"
            ? { marketplaces: [marketplace], marketplaceLoadErrors: [] }
            : { marketplaces: [marketplace], marketplaceLoadErrors: [], featuredPluginIds: [] };
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toEqual([]);
    expect(inventory.diagnostics).toEqual([
      expect.objectContaining({ code: "marketplace_missing" }),
    ]);
  });

  it("selects the authorized marketplace when two catalogs contain the same plugin name", async () => {
    const inventory = await readCodexPluginInventory({
      pluginConfig: configuredPlugin("trusted-company", "audit"),
      request: async (method, params) => {
        if (method === "plugin/installed") {
          return {
            marketplaces: [
              {
                name: "untrusted-company",
                path: "/untrusted/marketplace.json",
                interface: null,
                plugins: [pluginSummary("audit", { installed: true, enabled: true })],
              },
              {
                name: "trusted-company",
                path: "/trusted/marketplace.json",
                interface: null,
                plugins: [pluginSummary("audit", { installed: true, enabled: true })],
              },
            ],
            marketplaceLoadErrors: [],
          } satisfies v2.PluginInstalledResponse;
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/trusted/marketplace.json",
            pluginName: "audit",
          });
          return pluginDetail("audit", [], {
            marketplaceName: "trusted-company",
            marketplacePath: "/trusted/marketplace.json",
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toHaveLength(1);
    expect(inventory.records[0]?.policy.marketplaceName).toBe("trusted-company");
  });

  it("does not reuse a partial repository catalog when resolving the curated marketplace", async () => {
    const metadataCache = new CodexPluginMetadataCache();
    let catalogCalls = 0;
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "a-security": {
              marketplaceName: "company-tools",
              pluginName: "security-review",
            },
            "z-calendar": {
              marketplaceName: "openai-curated",
              pluginName: "calendar",
            },
          },
        },
      },
      appCacheKey: "runtime",
      configCwd: "/repo/company",
      metadataCache,
      request: async (method) => {
        if (method === "plugin/installed") {
          return { marketplaces: [], marketplaceLoadErrors: [] };
        }
        if (method === "plugin/list") {
          catalogCalls += 1;
          return catalogCalls === 1
            ? pluginList([pluginSummary("security-review")], {
                name: "company-tools",
                path: "/repo/company/.agents/plugins/marketplace.json",
              })
            : pluginList([pluginSummary("calendar")], {
                name: "openai-curated",
                path: "/managed/openai-curated/marketplace.json",
              });
        }
        if (method === "plugin/read") {
          return pluginDetail(catalogCalls === 1 ? "security-review" : "calendar", []);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(catalogCalls).toBe(2);
    expect(inventory.records.map((record) => record.policy.configKey)).toEqual([
      "a-security",
      "z-calendar",
    ]);
    expect(inventory.diagnostics).toEqual([]);
  });

  it("never exposes plugins disabled by an administrator", async () => {
    const calls: string[] = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: configuredPlugin("enterprise", "audit"),
      request: async (method, params) => {
        calls.push(method);
        if (method === "plugin/installed") {
          return pluginInstalled(
            [
              pluginSummary("audit", {
                installed: true,
                enabled: true,
                availability: "DISABLED_BY_ADMIN",
              }),
            ],
            { name: "enterprise", path: "/enterprise/marketplace.json" },
          );
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/enterprise/marketplace.json",
            pluginName: "audit",
          });
          return pluginDetail("audit", [appSummary("admin-denied-app")], {
            marketplaceName: "enterprise",
            marketplacePath: "/enterprise/marketplace.json",
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toEqual(["plugin/installed", "plugin/read"]);
    expect(inventory.records[0]).toMatchObject({
      activationRequired: true,
      ownedAppIds: ["admin-denied-app"],
    });
    expect(inventory.diagnostics).toEqual([expect.objectContaining({ code: "plugin_disabled" })]);
  });
});

const approvalAppMetadata = {
  id: "linear",
  name: "linear",
  description: null,
  iconUrl: null,
  iconUrlDark: null,
  distributionChannel: null,
  installUrl: null,
  pluginDisplayNames: [],
  toolSummaries: null,
};

describe("Codex owned app approval metadata", () => {
  it("keeps approval checks conservative when tool metadata is absent", () => {
    expect(toCodexPluginOwnedAccountApp(approvalAppMetadata)).not.toHaveProperty(
      "approvalOverrideToolConfigKeys",
    );
    expect(
      toCodexPluginOwnedAccountApp({ ...approvalAppMetadata, toolSummaries: [] })
        .approvalOverrideToolConfigKeys,
    ).toStrictEqual([]);
  });

  it("preserves writable approval checks for keys shared with read-only tools", () => {
    const app = {
      ...approvalAppMetadata,
      toolSummaries: [
        {
          name: "fetch",
          title: "Fetch",
          description: "Fetch a Linear issue.",
          isEnabled: true,
          disabledReason: null,
          isReadOnly: true,
        },
        {
          name: "linear_fetch",
          title: "Save issue",
          description: "Create or update a Linear issue.",
          isEnabled: false,
          disabledReason: "App policy",
          isReadOnly: false,
        },
      ],
    };

    expect(toCodexPluginOwnedAccountApp(app).approvalOverrideToolConfigKeys).toStrictEqual([
      "Save issue",
      "linear_fetch",
      "linear_linear_fetch",
    ]);
  });
});
