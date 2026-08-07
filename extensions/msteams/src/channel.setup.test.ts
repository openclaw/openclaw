// Msteams tests cover setup-channel account operations.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { msteamsSetupPlugin } from "./channel.setup.js";

describe("msteamsSetupPlugin", () => {
  it("deletes account-scoped default Teams identity config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
          accounts: {
            default: {
              appId: "default-app-id",
              appPassword: "default-secret",
              webhook: { port: 3978 },
            },
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
          defaultAccount: "default",
        },
      },
    };

    expect(msteamsSetupPlugin.config?.deleteAccount?.({ cfg, accountId: "default" })).toEqual({
      channels: {
        msteams: {
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { port: 3979 },
            },
          },
        },
      },
    });
  });
});
