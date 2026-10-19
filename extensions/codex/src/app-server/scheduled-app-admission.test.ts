import { describe, expect, it } from "vitest";
import { buildPluginAppPolicyContext } from "./plugin-thread-config.js";
import { intersectCodexPluginThreadConfigWithScheduledAuthority } from "./scheduled-app-authority.js";
import {
  createScheduledAppAuthority,
  createScheduledAppThreadConfig,
} from "./scheduled-app-authority.test-support.js";
import type { CodexScheduledAppTool } from "./scheduled-app-tool-policy.js";

describe("scheduled admitted apps under native deny defaults", () => {
  it.each([false, true])(
    "retains admission and explicit restrictions (owner defaults=%s)",
    (ownerDefaults) => {
      const context = buildPluginAppPolicyContext(
        {
          calendar: {
            source: "account",
            appName: "Calendar",
            allowDestructiveActions: true,
            allowOpenWorld: true,
            destructiveApprovalMode: "allow",
            mcpServerNames: [],
          },
        },
        {},
      );
      const config = { ...createScheduledAppThreadConfig(), policyContext: context };
      const authority = {
        ...createScheduledAppAuthority(),
        ...(ownerDefaults ? { allowOwnerToolDefaults: true as const } : {}),
      };
      const toolsByApp = new Map([
        [
          "calendar",
          new Map<string, CodexScheduledAppTool>([
            ["list", { readOnlyHint: true, destructiveHint: false, openWorldHint: false }],
            ["edit", { destructiveHint: true, openWorldHint: true }],
          ]),
        ],
      ]);
      const cases = [
        { name: "admitted app", app: undefined, list: true, edit: true },
        { name: "explicit app deny", app: { enabled: false }, list: false, edit: false },
        {
          name: "app tool default deny",
          app: { default_tools_enabled: false },
          list: false,
          edit: false,
        },
        {
          name: "tool deny",
          app: { tools: { edit: { enabled: false } } },
          list: true,
          edit: false,
        },
        { name: "destructive deny", app: { destructive_enabled: false }, list: true, edit: false },
        { name: "open-world deny", app: { open_world_enabled: false }, list: true, edit: false },
      ];
      for (const { name, app, list, edit } of cases) {
        const result = intersectCodexPluginThreadConfigWithScheduledAuthority(
          config,
          authority,
          {
            config: {
              apps: {
                _default: {
                  enabled: false,
                  destructive_enabled: false,
                  open_world_enabled: false,
                  default_tools_approval_mode: "prompt",
                },
                ...(app ? { calendar: app } : {}),
                unrelated: { enabled: true },
              },
            },
            toolsByApp,
          },
          true,
        );
        expect(result.configPatch?.apps, name).toMatchObject({
          _default: { enabled: false },
          calendar: {
            tools: {
              list: { enabled: list, approval_mode: "prompt" },
              edit: { enabled: edit, approval_mode: "prompt" },
            },
          },
          unrelated: { enabled: false },
        });
      }
    },
  );
});
