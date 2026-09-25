import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginList,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { buildCodexPluginThreadConfig } from "./plugin-thread-config.js";

const missingCases = [
  { marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME, code: "plugin_missing" },
  { marketplaceName: "missing-marketplace", code: "marketplace_missing" },
].flatMap((missing) =>
  [false, "ask" as const].flatMap((actions) =>
    [true, false].map((enabled) => ({
      marketplaceName: missing.marketplaceName,
      code: missing.code,
      actions,
      enabled,
    })),
  ),
);

describe("missing configured plugins", () => {
  it.each(missingCases)(
    "keeps healthy runtime apps for $code with actions=$actions enabled=$enabled",
    async ({ marketplaceName, code, actions, enabled }) => {
      const pluginConfig = {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "auto",
          plugins: {
            healthy: {
              pluginName: "healthy",
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              allow_destructive_actions: "ask",
            },
            missing: {
              pluginName: "missing",
              marketplaceName,
              enabled,
              allow_destructive_actions: actions,
            },
          },
        },
      };
      const savedSettings = structuredClone(pluginConfig);
      const result = await buildCodexPluginThreadConfig({
        pluginConfig,
        appCache: new CodexAppInventoryCache(),
        appCacheKey: "missing-plugin",
        request: inventoryRequest(() => false),
      });
      expect(result.inventory?.policy.pluginPolicies.map((plugin) => plugin.configKey)).toEqual([
        "healthy",
      ]);
      expect(result.inventory?.records.map((record) => record.policy.configKey)).toEqual([
        "healthy",
      ]);
      expect(result.policyContext.apps["healthy-app"]).toMatchObject({
        pluginName: "healthy",
        marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
        destructiveApprovalMode: "ask",
      });
      // Even an app display name matching the missing entry follows account policy.
      expect(result.policyContext.apps["account-app"]).toMatchObject({
        source: "account",
        allowDestructiveActions: true,
        destructiveApprovalMode: "auto",
      });
      expect(result.configPatch?.apps).toMatchObject({
        "healthy-app": { enabled: true, approvals_reviewer: "user" },
        "account-app": { enabled: true, destructive_enabled: true },
      });
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
      expect(pluginConfig).toEqual(savedSettings);
    },
  );

  it("discovers a previously missing plugin on a later inventory read", async () => {
    let available = false;
    const pluginConfig = {
      codexPlugins: {
        enabled: true,
        plugins: {
          healthy: { pluginName: "healthy", marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME },
          missing: { pluginName: "missing", marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME },
        },
      },
    };
    const savedSettings = structuredClone(pluginConfig);
    const params = {
      pluginConfig,
      appCache: new CodexAppInventoryCache(),
      appCacheKey: "later-discovery",
      request: inventoryRequest(() => available),
    };
    const first = await buildCodexPluginThreadConfig(params);
    expect(first.inventory?.policy.pluginPolicies.map((plugin) => plugin.configKey)).toEqual([
      "healthy",
    ]);
    expect(first.policyContext.apps["healthy-app"]).toMatchObject({ pluginName: "healthy" });
    available = true;
    const next = await buildCodexPluginThreadConfig(params);
    expect(next.inventory?.policy.pluginPolicies.map((plugin) => plugin.configKey)).toEqual([
      "healthy",
      "missing",
    ]);
    expect(next.policyContext.apps["account-app"]).toMatchObject({ pluginName: "missing" });
    expect(pluginConfig).toEqual(savedSettings);
  });
});

function inventoryRequest(isMissingAvailable: () => boolean) {
  return vi.fn(async (method: string, params?: unknown) => {
    const summaries = ["healthy", ...(isMissingAvailable() ? ["missing"] : [])].map((name) =>
      pluginSummary(name, { installed: true, enabled: true }),
    );
    if (method === "plugin/installed") {
      return pluginInstalled(summaries);
    }
    if (method === "plugin/list") {
      return pluginList(summaries);
    }
    if (method === "plugin/read") {
      const name = (params as { pluginName: string }).pluginName;
      return pluginDetail(name, [appSummary(name === "healthy" ? "healthy-app" : "account-app")]);
    }
    if (method === "app/installed" || method === "app/read") {
      return codexAppInventoryResponse(method, [
        appInfo("healthy-app", true),
        { ...appInfo("account-app", true), pluginDisplayNames: ["missing"] },
      ]);
    }
    if (method === "config/read") {
      return { config: {}, layers: [] };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
}
