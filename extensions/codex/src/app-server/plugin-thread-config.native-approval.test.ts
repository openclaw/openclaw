import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { cacheCodexAppsForTest, codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  appInfo,
  pluginDetail,
  pluginInstalled,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  buildCodexPluginThreadConfig,
  mergeCodexThreadConfigs,
  refreshCodexPluginAppApprovalPolicy,
} from "./plugin-thread-config.js";
import type { CodexAppServerRequestParams, v2 } from "./protocol.js";

describe("Codex native app approval settings", () => {
  it("preserves native approval settings on initial and retained threads", async () => {
    const nativeApp = {
      default_tools_approval_mode: "prompt",
      approvals_reviewer: "auto_review",
      links: { account: { default_tools_approval_mode: "writes" } },
      tools: { read: { approval_mode: "approve" } },
    };
    const nativeConfig = { apps: { "calendar-app": nativeApp } };
    const request = async (method: string, params?: unknown) => {
      if (method === "config/read") {
        return { config: nativeConfig, layers: [] };
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(
          method,
          [appInfo("calendar-app", true)],
          params as CodexAppServerRequestParams<typeof method>,
        );
      }
      throw new Error(`unexpected request ${method}`);
    };
    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "auto",
        },
      },
      appCache: new CodexAppInventoryCache(),
      appCacheKey: "native-approval",
      request,
    });
    const replay = await refreshCodexPluginAppApprovalPolicy({
      policyContext: config.policyContext,
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "auto",
        },
      },
      request,
    });

    for (const patch of [
      config.configPatch,
      buildCodexPluginAppsConfigPatchFromPolicyContext(config.policyContext),
      replay.configPatch,
    ]) {
      expect(mergeCodexThreadConfigs(nativeConfig, patch)?.apps).toMatchObject({
        "calendar-app": {
          ...nativeApp,
          enabled: true,
          destructive_enabled: true,
          open_world_enabled: true,
        },
      });
    }
    expect(config.diagnostics).toEqual([]);
    expect(replay.diagnostics).toEqual([]);
  });

  it("binds MCP-only plugins to verified server names and blocks shared names", async () => {
    const appCache = await cacheCodexAppsForTest([]);
    const summaries = [
      pluginSummary("native/alpha", { name: "alpha", installed: true, enabled: true }),
      pluginSummary("native/beta", { name: "beta", installed: true, enabled: true }),
    ];
    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            alphaPolicy: { marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME, pluginName: "alpha" },
            betaPolicy: { marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME, pluginName: "beta" },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        if (method === "plugin/installed") {
          return pluginInstalled(summaries);
        }
        if (method === "plugin/read") {
          const name = (params as v2.PluginReadParams).pluginName;
          const detail = pluginDetail(name, []);
          detail.plugin.mcpServers = name === "alpha" ? ["alpha", "shared"] : ["beta", "shared"];
          return detail;
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.policyContext.apps).toEqual({});
    expect(config.policyContext.mcpServers).toEqual({
      alpha: "native/alpha",
      beta: "native/beta",
      shared: null,
    });
    expect(config.policyContext.nativePlugins).toMatchObject({
      "native/alpha": { configKey: "alphaPolicy" },
      "native/beta": { configKey: "betaPolicy" },
    });
    expect(config.policyContext.pluginAppIds).toEqual({});
  });

  it("keeps native owners when detail is unavailable and blocks duplicate IDs", async () => {
    const summaries = [
      pluginSummary("native/shared", { name: "alpha", installed: true, enabled: true }),
      pluginSummary("native/shared", { name: "beta", installed: true, enabled: true }),
      pluginSummary("native/gamma", { name: "gamma", installed: true, enabled: true }),
    ];
    const config = await buildCodexPluginThreadConfig({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: Object.fromEntries(
            ["alpha", "beta", "gamma"].map((name) => [
              name,
              { marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME, pluginName: name },
            ]),
          ),
        },
      },
      appCache: await cacheCodexAppsForTest([]),
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        if (method === "plugin/installed") {
          return pluginInstalled(summaries);
        }
        if (method === "plugin/read") {
          const name = (params as v2.PluginReadParams).pluginName;
          if (name === "gamma") {
            throw new Error("plugin detail unavailable");
          }
          return pluginDetail(name, []);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(config.policyContext.nativePlugins).toMatchObject({
      "native/shared": null,
      "native/gamma": { configKey: "gamma", mcpServerNames: [] },
    });
    expect(config.policyContext.mcpServers).toEqual({});
    expect(config.diagnostics).toContainEqual(
      expect.objectContaining({ code: "plugin_detail_unavailable" }),
    );
  });
});
