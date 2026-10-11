import { describe, expect, it } from "vitest";
import { intersectCodexPluginThreadConfigWithScheduledAuthority } from "./scheduled-app-authority.js";
import {
  createScheduledAppAuthority as authority,
  createScheduledAppThreadConfig as threadConfig,
} from "./scheduled-app-authority.test-support.js";

describe("scheduled Codex owner-default apps", () => {
  it.each([
    { nativeToolSurfaceEnabled: false, nativeReadMode: "auto" },
    { nativeToolSurfaceEnabled: true, nativeReadMode: "auto" },
    { nativeToolSurfaceEnabled: true, nativeReadMode: "prompt" },
  ] as const)(
    "refreshes apps with native=$nativeToolSurfaceEnabled and read approval=$nativeReadMode",
    ({ nativeToolSurfaceEnabled, nativeReadMode }) => {
      const config = threadConfig();
      const newlyConnectedApp = config.policyContext.apps.newly_connected;
      if (!newlyConnectedApp) {
        throw new Error("Missing newly-connected app fixture");
      }
      newlyConnectedApp.destructiveApprovalMode = "ask";
      config.configPatch = {
        apps: {
          calendar: { enabled: true, destructive_enabled: false },
          newly_connected: {
            enabled: true,
            approvals_reviewer: "user",
            tools: {
              read: { enabled: true, approval_mode: "auto" },
              write: { enabled: true, approval_mode: "prompt" },
            },
          },
        },
      };
      const result = intersectCodexPluginThreadConfigWithScheduledAuthority(
        config,
        { ...authority(), allowOwnerToolDefaults: true },
        {
          config: {
            apps: {
              newly_connected: {
                enabled: true,
                tools: { read: { approval_mode: nativeReadMode } },
              },
            },
          },
          toolsByApp: new Map([
            ["calendar", new Map([["list", {}]])],
            [
              "newly_connected",
              new Map([
                ["read", { readOnlyHint: true }],
                ["write", { destructiveHint: true }],
              ]),
            ],
          ]),
        },
        nativeToolSurfaceEnabled,
      );

      expect(result.provisionalAppIds).toEqual(
        nativeToolSurfaceEnabled ? ["calendar", "newly_connected"] : ["calendar"],
      );
      expect(result.configPatch).toMatchObject({
        apps: { newly_connected: { enabled: nativeToolSurfaceEnabled } },
      });
      if (nativeToolSurfaceEnabled) {
        expect(result.configPatch).toMatchObject({
          apps: {
            newly_connected: {
              approvals_reviewer: "user",
              tools: {
                read: { enabled: true, approval_mode: nativeReadMode },
                write: { enabled: true, approval_mode: "prompt" },
              },
            },
          },
        });
      }
    },
  );
});
