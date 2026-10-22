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
import { preparePluginThreadConfigForTest } from "./plugin-thread-config.test-helpers.js";
import type { CodexAppServerRequestParams, v2 } from "./protocol.js";
import {
  captureScheduledCodexAppAuthority,
  buildScheduledCodexAppAuthorityInputFingerprint,
} from "./scheduled-app-authority.js";

describe("scheduled read-only authority", () => {
  it.each([false, true])(
    "retains the creator read-only ceiling after config relaxation (missing metadata: %s)",
    async (missingMetadata) => {
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
      const request = vi.fn(async (method: string, params: unknown) => {
        if (method === "config/read") {
          return { config: {}, layers: [] };
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
                    `calendar_${t.name}`,
                    { title: `Calendar_${t.name}`, _meta: { connector_id: "calendar" } },
                  ]),
                ),
              },
            ],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected method ${method}`);
      });
      const build = (stored?: Awaited<ReturnType<typeof captureScheduledCodexAppAuthority>>) =>
        preparePluginThreadConfigForTest(
          {
            codexPlugins: {
              enabled: true,
              plugins: {
                calendar: {
                  marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                  pluginName: "calendar",
                  read_only: readOnly,
                  allow_destructive_actions: true,
                },
              },
            },
          },
          "creator-read-only",
          stored,
        )({
          requestTimeoutMs: 5_000,
          signal: new AbortController().signal,
          client: { request } as never,
          appCache: new CodexAppInventoryCache(),
          scheduledRuntimeAuthority: stored,
        }).build(stored ? { threadId: "scheduled-thread" } : undefined);
      const creator = await build();
      const captured = await captureScheduledCodexAppAuthority({
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
      tools = [
        tool("list", false),
        tool("edit", false),
        tool("new_read", true),
        tool("new_write", false),
        tool("disabled_read", true, false),
      ];
      const replay = await build(stored);
      expect(replay.configPatch).toMatchObject({
        apps: {
          calendar: {
            default_tools_enabled: false,
            tools: {
              calendar_list: { enabled: false },
              calendar_edit: { enabled: false },
              calendar_new_read: { enabled: !missingMetadata },
              calendar_new_write: { enabled: false },
              calendar_disabled_read: { enabled: false },
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
