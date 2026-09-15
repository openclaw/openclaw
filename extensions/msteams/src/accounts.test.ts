import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listMSTeamsAccountIds, resolveMSTeamsRuntimeAccount } from "./accounts.js";
import { msteamsConfigAdapter } from "./channel-config.js";

describe("msteams account selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not let partial default environment credentials override a configured named account", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "partial-default-app-id");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
    vi.stubEnv("MSTEAMS_TENANT_ID", "");
    const cfg = {
      channels: {
        msteams: {
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              tenantId: "support-tenant-id",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["support"]);
    expect(resolveMSTeamsRuntimeAccount({ cfg })).toMatchObject({
      accountId: "support",
      credentials: {
        appId: "support-app-id",
        appPassword: "support-secret",
        tenantId: "support-tenant-id",
      },
    });
  });

  it("inspects unresolved account SecretRefs without resolving them", () => {
    const sourceConfig = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: {
                source: "env",
                provider: "default",
                id: "SUPPORT_MSTEAMS_SECRET",
              },
              webhook: { port: 3979 },
            },
          },
        },
      },
    } as OpenClawConfig;
    const resolvedConfig = structuredClone(sourceConfig);
    resolvedConfig.channels!.msteams!.accounts!.support!.appPassword = "resolved-secret";

    expect(msteamsConfigAdapter.inspectAccount?.(sourceConfig, "support")).toMatchObject({
      accountId: "support",
      configured: true,
      tokenStatus: "configured_unavailable",
      port: 3979,
    });
    expect(msteamsConfigAdapter.inspectAccount?.(resolvedConfig, "support")).toMatchObject({
      accountId: "support",
      configured: true,
      tokenStatus: "available",
      port: 3979,
    });
  });
});
