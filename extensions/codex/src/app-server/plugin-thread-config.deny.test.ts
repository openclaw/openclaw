import { describe, expect, it } from "vitest";
import { nativeAppToolsResponse } from "./app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  mergeCodexThreadConfigs,
  refreshCodexPluginAppApprovalPolicy,
} from "./plugin-thread-config.js";
import { buildReadyGoogleCalendarThreadConfig } from "./plugin-thread-config.test-helpers.js";
import type { JsonObject } from "./protocol.js";

describe("Codex plugin destructive denial", () => {
  it.each(["default", "tool"])(
    "enforces destructive denial over native %s enablement on initial and replayed threads",
    async (enablement) => {
      const nativeConfig: JsonObject = {
        apps: {
          "google-calendar-app": {
            default_tools_enabled: enablement === "default",
            default_tools_approval_mode: "approve",
            approvals_reviewer: "user",
            links: { account: { default_tools_approval_mode: "prompt" } },
            tools: {
              "Read event": { enabled: true, approval_mode: "prompt" },
              policy_delete: {
                ...(enablement === "tool" ? { enabled: true } : {}),
                approval_mode: "approve",
              },
              retired: { enabled: true },
              native_disabled: { enabled: false },
              safe_write: { enabled: true, approval_mode: "approve" },
            },
          },
        },
      };
      const nativeTools = {
        read_event: {
          title: "Read event",
          annotations: { destructiveHint: false, readOnlyHint: true },
        },
        safe_write: { annotations: { destructiveHint: false, readOnlyHint: false } },
        policy_delete: { annotations: { destructiveHint: true, readOnlyHint: true } },
        unknown: {},
        native_disabled: { annotations: { destructiveHint: false } },
      };
      const config = await buildReadyGoogleCalendarThreadConfig(
        {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: false,
            plugins: {
              "google-calendar": {
                marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                pluginName: "google-calendar",
              },
            },
          },
        },
        nativeConfig,
        nativeTools,
      );
      const replay = await refreshCodexPluginAppApprovalPolicy({
        policyContext: config.policyContext,
        request: async (method) => {
          if (method === "config/read") {
            return { config: nativeConfig, layers: [] };
          }
          if (method === "mcpServerStatus/list") {
            return nativeAppToolsResponse("google-calendar-app", nativeTools);
          }
          throw new Error(`unexpected request ${method}`);
        },
      });
      for (const patch of [config.configPatch, replay.configPatch]) {
        const effective = mergeCodexThreadConfigs(nativeConfig, patch);
        expect(effective?.apps).toMatchObject({
          "google-calendar-app": {
            enabled: true,
            default_tools_enabled: false,
            default_tools_approval_mode: "auto",
            approvals_reviewer: "user",
            links: { account: { default_tools_approval_mode: "prompt" } },
            tools: {
              "Read event": { enabled: false },
              read_event: { enabled: true, approval_mode: "prompt" },
              safe_write: { enabled: true, approval_mode: "approve" },
              policy_delete: { enabled: false },
              unknown: { enabled: false },
              native_disabled: { enabled: false },
              retired: { enabled: false },
            },
          },
        });
      }
      // A persisted app ID by itself is insufficient to recreate the tool ceiling.
      expect(
        buildCodexPluginAppsConfigPatchFromPolicyContext(config.policyContext).apps,
      ).toMatchObject({ "google-calendar-app": { enabled: false } });
      expect(config.diagnostics).toEqual([]);
      expect(replay.diagnostics).toEqual([]);
    },
  );
});
