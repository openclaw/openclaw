import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { appInfo } from "./plugin-inventory.test-helpers.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  buildCodexPluginThreadConfig,
  mergeCodexThreadConfigs,
  refreshCodexPluginAppApprovalPolicy,
} from "./plugin-thread-config.js";
import type { CodexAppServerRequestParams } from "./protocol.js";

describe("Codex native app approval settings", () => {
  it.each([
    ["prompt", "user"],
    ["prompt", "auto_review"],
    ["approve", "user"],
  ] as const)(
    "preserves %s with %s review on initial and retained threads",
    async (mode, reviewer) => {
      const nativeApp = {
        default_tools_approval_mode: mode,
        approvals_reviewer: reviewer,
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
    },
  );
});
