import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import {
  createCodexPluginThreadConfigStartupProvider,
  resolveCodexPluginThreadConfigStartupPolicy,
} from "./plugin-thread-config-deadline.js";
import type { CodexAppServerRequestParams, v2 } from "./protocol.js";
import {
  captureScheduledCodexAppAuthority,
  buildScheduledCodexAppAuthorityInputFingerprint,
} from "./scheduled-app-authority.js";

describe("scheduled read-only authority", () => {
  it.each(
    [false, true].flatMap((missingMetadata) =>
      [false, true].map((ownerDefaults) => ({ missingMetadata, ownerDefaults })),
    ),
  )(
    "retains the creator read-only ceiling (missing metadata: $missingMetadata, owner defaults: $ownerDefaults)",
    async ({ missingMetadata, ownerDefaults }) => {
      type Tool = NonNullable<v2.AppInfo["toolSummaries"]>[number];
      const tool = (name: string, isReadOnly: boolean, isEnabled = true): Tool => ({
        name,
        title: null,
        description: "",
        isReadOnly,
        isEnabled,
        disabledReason: null,
      });
      let tools: Tool[] = [tool("list", true), tool("edit", false)];
      let readOnly = true;
      let destructive: "auto" | "ask" = "ask";
      const request = vi.fn(async (method: string, params: unknown) => {
        if (method === "config/read") {
          return {
            config: {
              apps: {
                calendar: {
                  default_tools_enabled: false,
                  tools: { "calendar.native_disabled": { enabled: false } },
                },
              },
            },
            layers: [],
          };
        }
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginInstalled([pluginSummary("calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginDetail("calendar", [appSummary("calendar")]);
        }
        if (method === "app/read" || method === "app/installed") {
          return codexAppInventoryResponse(
            method,
            [
              {
                ...appInfo("calendar", true),
                name: "Calendar",
                toolSummaries: missingMetadata && !readOnly ? undefined : tools,
              },
            ],
            params as CodexAppServerRequestParams<typeof method>,
          );
        }
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "codex_apps",
                tools: Object.fromEntries(
                  tools.map((t) => [
                    `calendar.${t.name}`,
                    {
                      title: `Calendar_${t.name}`,
                      annotations: { readOnlyHint: t.isReadOnly },
                      _meta: {
                        connector_id: "calendar",
                        _codex_apps: { resource_uri: `/calendar/link/${t.name}` },
                      },
                    },
                  ]),
                ),
              },
            ],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected method ${method}`);
      });
      const build = (stored?: Awaited<ReturnType<typeof captureScheduledCodexAppAuthority>>) => {
        const pluginConfig = {
          codexPlugins: {
            enabled: true,
            plugins: {
              calendar: {
                marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                pluginName: "calendar",
                read_only: readOnly,
                allow_destructive_actions: destructive,
              },
            },
          },
        };
        const startup = resolveCodexPluginThreadConfigStartupPolicy({
          pluginConfig,
          nativeToolSurfaceEnabled: true,
          scheduledRuntimeAuthority: stored,
        });
        return createCodexPluginThreadConfigStartupProvider({
          inputFingerprint: "creator-read-only",
          enabledPluginConfigKeys: startup.enabledPluginConfigKeys,
          policy: startup.resolvedPluginPolicy,
          pluginConfig: startup.pluginThreadConfigPluginConfig,
          appCacheKey: "creator-read-only",
          nativeToolSurfaceEnabled: true,
          requestTimeoutMs: 5_000,
          signal: new AbortController().signal,
          client: { request } as never,
          appCache: new CodexAppInventoryCache(),
          scheduledRuntimeAuthority: stored,
        }).build(stored ? { threadId: "scheduled-thread" } : undefined);
      };
      const creator = await build();
      const captured = await captureScheduledCodexAppAuthority({
        nativeToolSurfaceEnabled: ownerDefaults,
        client: { request } as never,
        threadId: "creator-thread",
        policyContext: creator.policyContext,
        auth: { kind: "prepared-profile", profileId: "openai:work", accountId: "acct-1" },
      });
      // Round-trip the persisted cron envelope; current settings no longer enforce read-only.
      const serializedAuthority = JSON.stringify(captured);
      const stored: Awaited<ReturnType<typeof captureScheduledCodexAppAuthority>> =
        JSON.parse(serializedAuthority);
      readOnly = false;
      destructive = "auto";
      tools = [
        tool("list", false),
        tool("edit", false),
        tool("new_read", true),
        tool("new_write", false),
        tool("disabled_read", true, false),
        tool("native_disabled", true),
      ];
      const replay = await build(stored);
      expect(replay.configPatch).toMatchObject({
        apps: {
          calendar: {
            default_tools_enabled: false,
            tools: {
              "calendar.list": { enabled: false },
              "calendar.edit": { enabled: false },
              "calendar.new_read": {
                enabled: !missingMetadata,
                approval_mode: "auto",
              },
              "calendar.new_write": {
                enabled: false,
                approval_mode: ownerDefaults ? "auto" : "prompt",
              },
              "calendar.disabled_read": { enabled: false },
              "calendar.native_disabled": { enabled: false },
            },
          },
        },
      });
      expect(stored).toMatchObject({ payload: { apps: [{ readOnly: true }] } });
      const invalidStored = JSON.parse(serializedAuthority);
      invalidStored.payload.apps[0].readOnly = "true";
      expect(() => buildScheduledCodexAppAuthorityInputFingerprint("base", invalidStored)).toThrow(
        /Stored Codex app authority is invalid/,
      );
    },
  );
});
