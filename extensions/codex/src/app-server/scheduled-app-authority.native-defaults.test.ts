import { describe, expect, it } from "vitest";
import { buildPluginAppPolicyContext } from "./plugin-thread-config.js";
import { intersectCodexPluginThreadConfigWithScheduledAuthority } from "./scheduled-app-authority.js";
import {
  createScheduledAppAuthority as authority,
  createScheduledAppThreadConfig as threadConfig,
} from "./scheduled-app-authority.test-support.js";

describe("scheduled Codex app admission over native defaults", () => {
  it.each([false, true])(
    "enables admitted tools over native deny defaults (owner defaults=%s)",
    (native) => {
      const config = threadConfig();
      config.policyContext = buildPluginAppPolicyContext(
        {
          calendar: {
            ...config.policyContext.apps.calendar,
            allowDestructiveActions: true,
            allowOpenWorld: true,
            destructiveApprovalMode: "allow",
          },
        },
        {},
      );
      if (native) {
        delete config.policyContext.apps.calendar.allowOpenWorld;
      }
      const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
        config,
        { ...authority(), ...(native ? { allowOwnerToolDefaults: true as const } : {}) },
        {
          config: {
            apps: {
              _default: {
                enabled: false,
                destructive_enabled: false,
                open_world_enabled: false,
              },
            },
          },
          toolsByApp: new Map([
            [
              "calendar",
              new Map([
                ["list", {}],
                ["edit", {}],
              ]),
            ],
          ]),
        },
        native,
      );

      expect(intersected.configPatch).toMatchObject({
        apps: {
          _default: {
            enabled: false,
            destructive_enabled: false,
            open_world_enabled: false,
          },
          calendar: {
            enabled: true,
            tools: { list: { enabled: true }, edit: { enabled: true } },
          },
        },
      });
    },
  );
});
