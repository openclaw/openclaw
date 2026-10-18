import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listMSTeamsAccountIds,
  resolveMSTeamsAccount,
  resolveMSTeamsAccountConfig,
  resolveMSTeamsAccountConfigPath,
  resolveMSTeamsRuntimeAccount,
} from "./accounts.js";
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
    } satisfies OpenClawConfig;

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
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    resolvedConfig.channels!.msteams!.accounts!.support!.appPassword = "resolved-secret";

    expect(msteamsConfigAdapter.inspectAccount?.(sourceConfig, "support")).toMatchObject({
      accountId: "support",
      configured: true,
      tokenStatus: "configured_unavailable",
      path: "/hooks/3979",
    });
    expect(msteamsConfigAdapter.inspectAccount?.(resolvedConfig, "support")).toMatchObject({
      accountId: "support",
      configured: true,
      tokenStatus: "available",
      path: "/hooks/3979",
    });
  });

  it("preserves an authored default-account key in credential paths", () => {
    const cfg = {
      channels: {
        msteams: {
          defaultAccount: "Default",
          accounts: {
            Default: {
              appId: "default-app-id",
              appPassword: "default-secret",
              tenantId: "tenant-id",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveMSTeamsAccountConfigPath(cfg, "default")).toBe(
      "channels.msteams.accounts.Default",
    );
  });

  it("does not resolve legacy root credentials for arbitrary named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          appId: "app-id",
          appPassword: "secret",
          tenantId: "tenant-id",
        },
      },
    };
    const resolved = resolveMSTeamsAccountConfig(cfg, "typo-account");

    expect(resolved.appId).toBeUndefined();
    expect(resolved.appPassword).toBeUndefined();
    expect(resolved.tenantId).toBe("tenant-id");
    expect(resolveMSTeamsAccount({ cfg, accountId: "typo-account" })).toMatchObject({
      accountId: "typo-account",
      configured: false,
    });
  });

  it("lists root default and named accounts", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: { path: "/hooks/3978" },
          accounts: {
            secondary: {
              appId: "secondary-app-id",
              appPassword: "secondary-secret",
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["default", "secondary"]);
  });

  it("resolves display-style account keys through their canonical account ids", () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
          accounts: {
            "Support Bot": {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { path: "/hooks/3979" },
            },
          },
          defaultAccount: "Support Bot",
        },
      },
    } satisfies OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["support-bot"]);

    for (const accountId of ["Support Bot", "support-bot"]) {
      expect(resolveMSTeamsAccountConfig(cfg, accountId)).toMatchObject({
        appId: "support-app-id",
        appPassword: "support-secret",
        tenantId: "tenant-id",
        webhook: { path: "/hooks/3979" },
      });
      expect(resolveMSTeamsAccount({ cfg, accountId })).toMatchObject({
        accountId: "support-bot",
        configured: true,
        enabled: true,
      });
      expect(resolveMSTeamsRuntimeAccount({ cfg, accountId })).toMatchObject({
        accountId: "support-bot",
        credentials: {
          appId: "support-app-id",
          appPassword: "support-secret",
          tenantId: "tenant-id",
        },
      });
    }
    expect(resolveMSTeamsRuntimeAccount({ cfg })).toMatchObject({
      accountId: "support-bot",
      credentials: {
        appId: "support-app-id",
        appPassword: "support-secret",
        tenantId: "tenant-id",
      },
    });
  });

  it("keeps legacy root credentials as the implicit default account", () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          appId: "legacy-app-id",
          appPassword: "legacy-secret",
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
        },
      },
    } satisfies OpenClawConfig;

    expect(listMSTeamsAccountIds(cfg)).toEqual(["default"]);
    expect(resolveMSTeamsAccountConfig(cfg)).toMatchObject({
      appId: "legacy-app-id",
      appPassword: "legacy-secret",
      tenantId: "tenant-id",
      webhook: { path: "/api/messages" },
    });
    expect(resolveMSTeamsAccount({ cfg })).toMatchObject({
      accountId: "default",
      configured: true,
      enabled: true,
    });
  });

  it("derives named routes without inheriting root identity or compatibility listeners", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
          legacyWebhook: { port: 3978 },
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            secondary: {
              appId: "secondary-app-id",
              appPassword: "secondary-secret",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const secondary = resolveMSTeamsAccountConfig(cfg, "secondary");

    expect(secondary.appId).toBe("secondary-app-id");
    expect(secondary.appPassword).toBe("secondary-secret");
    expect(secondary.tenantId).toBe("tenant-id");
    expect(secondary.webhook).toEqual({ path: "/api/messages/secondary" });
    expect(secondary.allowFrom).toEqual(["*"]);
    expect(secondary.legacyWebhook).toBeUndefined();
  });

  it("keeps identity when resolving an already account-scoped named account config", () => {
    const cfg = {
      channels: {
        msteams: {
          enabled: true,
          defaultAccount: "secondary",
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } satisfies OpenClawConfig;

    const secondary = resolveMSTeamsAccountConfig(cfg, "secondary");

    expect(secondary.appId).toBe("secondary-app-id");
    expect(secondary.appPassword).toBe("secondary-secret");
    expect(secondary.tenantId).toBe("tenant-id");
    expect(secondary.webhook).toEqual({ path: "/api/messages" });
    expect(resolveMSTeamsAccount({ cfg, accountId: "secondary" }).configured).toBe(true);
  });

  it("marks named accounts without explicit identity as unconfigured", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
          accounts: {
            secondary: {
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveMSTeamsAccount({ cfg, accountId: "secondary" }).configured).toBe(false);
  });

  it("reports the root path for an unavailable certificate inherited by a named account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          enabled: true,
          tenantId: "tenant-id",
          authType: "federated",
          certificatePath: "/private/msteams-inherited-missing.pem",
          accounts: {
            support: {
              appId: "support-app-id",
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    };

    expect(resolveMSTeamsAccount({ cfg, accountId: "support" })).toMatchObject({
      configured: true,
      tokenStatus: "configured_unavailable",
      credentialDiagnostics: [
        { code: "CREDENTIAL_FILE_UNAVAILABLE", path: "channels.msteams.certificatePath" },
      ],
    });
  });
});
