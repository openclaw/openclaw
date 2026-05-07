import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  buildCodexPluginThreadConfig,
  buildCodexPluginThreadConfigInputFingerprint,
  isCodexPluginThreadBindingStale,
  mergeCodexThreadConfigs,
  shouldBuildCodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import type { v2 } from "./protocol-generated/typescript/index.js";

describe("Codex plugin thread config", () => {
  it("builds restrictive app config for accessible migrated plugin apps", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({
        data: [appInfo("google-calendar-app", true)],
        nextCursor: null,
      }),
    });

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail(
            "google-calendar",
            [appSummary("google-calendar-app")],
            ["google-calendar"],
          );
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
        "google-calendar-app": {
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: false,
          default_tools_enabled: true,
          default_tools_approval_mode: "prompt",
          tools: null,
        },
      },
    });
    expect(config.policyContext.apps["google-calendar-app"]).toEqual({
      appId: "google-calendar-app",
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
      allowDestructiveActions: true,
      mcpServerNames: ["google-calendar"],
    });
    expect(config.diagnostics).toEqual([]);
  });

  it("does not build plugin app config when disabled", async () => {
    expect(
      shouldBuildCodexPluginThreadConfig({
        codexPlugins: { enabled: false },
      }),
    ).toBe(false);

    const config = await buildCodexPluginThreadConfig({
      pluginConfig: { codexPlugins: { enabled: false } },
      appCacheKey: "runtime",
      request: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.enabled).toBe(false);
    expect(config.configPatch).toBeUndefined();
    expect(config.diagnostics).toEqual([]);
    expect(config.policyContext.apps).toEqual({});
  });

  it("fails closed when app inventory has not been cached yet", async () => {
    const appCache = new CodexAppInventoryCache();
    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      request: async (method) => {
        if (method === "app/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.configPatch).toEqual({
      apps: {
        _default: {
          enabled: false,
          destructive_enabled: false,
          open_world_enabled: false,
        },
      },
    });
    expect(config.policyContext.apps).toEqual({});
    expect(config.diagnostics).toContainEqual(
      expect.objectContaining({ code: "app_inventory_missing" }),
    );
  });

  it("uses app cache key and revision in the cheap input fingerprint", async () => {
    const appCache = new CodexAppInventoryCache();
    const first = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: { codexPlugins: { enabled: true } },
      appCache,
      appCacheKey: "runtime-a",
    });
    await appCache.refreshNow({
      key: "runtime-a",
      request: async () => ({ data: [], nextCursor: null }),
    });
    const second = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: { codexPlugins: { enabled: true } },
      appCache,
      appCacheKey: "runtime-a",
    });
    const third = buildCodexPluginThreadConfigInputFingerprint({
      pluginConfig: { codexPlugins: { enabled: true } },
      appCache,
      appCacheKey: "runtime-b",
    });

    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
  });

  it("merges app config with native hook config", () => {
    expect(
      mergeCodexThreadConfigs(
        { "features.codex_hooks": true, hooks: { PreToolUse: [] } },
        { apps: { _default: { enabled: false } } },
      ),
    ).toEqual({
      "features.codex_hooks": true,
      hooks: { PreToolUse: [] },
      apps: { _default: { enabled: false } },
    });
  });

  it("marks legacy and changed plugin app bindings stale only when relevant", () => {
    expect(
      isCodexPluginThreadBindingStale({
        codexPluginsEnabled: true,
        currentInputFingerprint: "input-2",
      }),
    ).toBe(true);
    expect(
      isCodexPluginThreadBindingStale({
        codexPluginsEnabled: true,
        bindingFingerprint: "config-1",
        bindingInputFingerprint: "input-1",
        currentInputFingerprint: "input-2",
        hasBindingPolicyContext: true,
      }),
    ).toBe(true);
    expect(
      isCodexPluginThreadBindingStale({
        codexPluginsEnabled: true,
        bindingFingerprint: "config-1",
        bindingInputFingerprint: "input-1",
        currentInputFingerprint: "input-1",
        hasBindingPolicyContext: true,
      }),
    ).toBe(false);
    expect(
      isCodexPluginThreadBindingStale({
        codexPluginsEnabled: false,
        bindingFingerprint: "config-1",
        bindingInputFingerprint: "input-1",
        hasBindingPolicyContext: true,
      }),
    ).toBe(true);
  });
});

function pluginList(plugins: v2.PluginSummary[]): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name: CODEX_PLUGINS_MARKETPLACE_NAME,
        path: "/marketplaces/openai-curated",
        interface: null,
        plugins,
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function pluginSummary(id: string, overrides: Partial<v2.PluginSummary> = {}): v2.PluginSummary {
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
    ...overrides,
  };
}

function pluginDetail(
  pluginName: string,
  apps: v2.AppSummary[],
  mcpServers: string[] = [],
): v2.PluginReadResponse {
  return {
    plugin: {
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      marketplacePath: "/marketplaces/openai-curated",
      summary: pluginSummary(pluginName, { installed: true, enabled: true }),
      description: null,
      skills: [],
      apps,
      mcpServers,
    },
  };
}

function appSummary(id: string): v2.AppSummary {
  return {
    id,
    name: id,
    description: null,
    installUrl: null,
    needsAuth: false,
  };
}

function appInfo(id: string, accessible: boolean): v2.AppInfo {
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
    isAccessible: accessible,
    isEnabled: true,
    pluginDisplayNames: [],
  };
}
