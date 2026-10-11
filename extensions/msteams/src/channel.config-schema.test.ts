import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";
import { msteamsSetupPlugin } from "./channel.setup.js";

describe("msteams config schema", () => {
  it("accepts named Teams bot accounts with explicit identities and paths", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      webhook: { path: "/api/messages" },
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { path: "/hooks/3978" },
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
      defaultAccount: "default",
    });

    expect(res.success).toBe(true);
  });

  it("validates named SSO after merging root and account settings", () => {
    const inheritedConnection = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      sso: { connectionName: "graph" },
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
          sso: { enabled: true },
        },
      },
    });
    const invalidOverride = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      sso: { enabled: true, connectionName: "graph" },
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
          sso: { connectionName: "" },
        },
      },
    });

    expect(inheritedConnection.success).toBe(true);
    expect(invalidOverride.success).toBe(false);
  });

  it("validates shared root settings only after merging named account overrides", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      dmPolicy: "open",
      sso: { enabled: true },
      cloud: "USGov",
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
          allowFrom: ["*"],
          sso: { connectionName: "graph" },
          serviceUrl: "https://smba.infra.gov.teams.microsoft.us/teams",
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("validates the effective default account allowlist", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      dmPolicy: "open",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { path: "/hooks/3978" },
          allowFrom: ["*"],
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("ignores runtime refinements for disabled named accounts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      dmPolicy: "open",
      sso: { enabled: true },
      cloud: "USGov",
      accounts: {
        retired: { enabled: false },
      },
    });

    expect(res.success).toBe(true);
  });

  it("does not reserve a partial environment default app ID", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "support-app-id");
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
    });
    vi.unstubAllEnvs();

    expect(res.success).toBe(true);
  });

  it("honors a managed identity opt-out when detecting an environment default", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "support-app-id");
    vi.stubEnv("MSTEAMS_TENANT_ID", "environment-tenant-id");
    vi.stubEnv("MSTEAMS_AUTH_TYPE", "federated");
    vi.stubEnv("MSTEAMS_USE_MANAGED_IDENTITY", "true");
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      useManagedIdentity: false,
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3978" },
        },
      },
    });
    vi.unstubAllEnvs();

    expect(res.success).toBe(true);
  });

  it("reserves an environment default completed by accounts.default auth settings", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "shared-app-id");
    vi.stubEnv("MSTEAMS_TENANT_ID", "environment-tenant-id");
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          authType: "federated",
          useManagedIdentity: true,
        },
        support: {
          appId: "shared-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3978" },
        },
      },
    });
    vi.unstubAllEnvs();

    expect(res.success).toBe(false);
  });

  it("rejects named Teams bot accounts with duplicate canonical account ids", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      webhook: { path: "/api/messages" },
      accounts: {
        "Support Bot": {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
        },
        "support-bot": {
          appId: "support-shadow-app-id",
          appPassword: "support-shadow-secret",
          webhook: { path: "/hooks/3980" },
        },
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["accounts", "support-bot"],
            message: expect.stringContaining('duplicate canonical account id "support-bot"'),
          }),
        ]),
      );
    }
  });

  it("rejects enabled named accounts without an effective tenant ID", () => {
    const res = MSTeamsConfigSchema.safeParse({
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects simultaneous root and accounts.default identity definitions", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "root-app-id",
      appPassword: "root-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "default-app-id",
          appPassword: "default-secret",
          webhook: { path: "/hooks/3978" },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects simultaneous root and canonical default account alias identity definitions", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "root-app-id",
      appPassword: "root-secret",
      tenantId: "tenant-id",
      accounts: {
        Default: {
          appId: "default-app-id",
          appPassword: "default-secret",
          webhook: { path: "/hooks/3978" },
        },
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["accounts", "Default"],
            message: expect.stringContaining("default Teams identity"),
          }),
        ]),
      );
    }
  });

  it("treats canonical default account aliases as default account config", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        Default: {
          appId: "default-app-id",
          appPassword: "default-secret",
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects duplicate enabled account webhook paths", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { path: "/hooks/3978" },
        },
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { path: "/hooks/3978" },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("rejects named accounts that collide with an environment-backed default route", () => {
    vi.stubEnv("MSTEAMS_APP_ID", "env-default-app");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-default-password");
    vi.stubEnv("MSTEAMS_TENANT_ID", "env-tenant-id");
    try {
      const res = MSTeamsConfigSchema.safeParse({
        tenantId: "shared-tenant-id",
        accounts: {
          secondary: {
            appId: "secondary-app-id",
            appPassword: "secondary-secret",
            webhook: { path: "/api/messages" },
          },
        },
      });
      const duplicateAppId = MSTeamsConfigSchema.safeParse({
        tenantId: "shared-tenant-id",
        webhook: { path: "/hooks/3980" },
        accounts: {
          secondary: {
            appId: "env-default-app",
            appPassword: "secondary-secret",
            webhook: { path: "/hooks/3979" },
          },
        },
      });

      expect(res.success).toBe(false);
      expect(duplicateAppId.success).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects whitespace-only passwords for enabled named secret accounts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        support: {
          appId: "support-app-id",
          appPassword: "   ",
          webhook: { path: "/hooks/3979" },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("deletes the default account identity while retaining the shared root webhook path", () => {
    const cfg = {
      channels: {
        msteams: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          tenantId: "tenant-id",
          webhook: {
            path: "/api/messages",
          },
          accounts: {
            default: {
              name: "Primary",
            },
            support: {
              appId: "support-app-id",
              appPassword: "support-secret",
              webhook: { path: "/hooks/3979" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = msteamsSetupPlugin.config?.deleteAccount?.({
      cfg,
      accountId: "default",
    });

    expect(next?.channels?.msteams).toEqual({
      tenantId: "tenant-id",
      webhook: {
        path: "/api/messages",
      },
      accounts: {
        default: { enabled: false },
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
    });
  });

  it("allows duplicate webhook paths when one account is disabled", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "primary-app-id",
          appPassword: "primary-secret",
          webhook: { path: "/hooks/3978" },
        },
        secondary: {
          enabled: false,
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { path: "/hooks/3978" },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects duplicate enabled account app IDs", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "shared-app-id",
          appPassword: "primary-secret",
          webhook: { path: "/hooks/3978" },
        },
        secondary: {
          appId: "SHARED-APP-ID",
          appPassword: "secondary-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it.each([
    { state: "enabled", enabled: undefined },
    { state: "disabled", enabled: false },
  ])("allows a $state logical account id matching another bot's appId", ({ enabled }) => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "support",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      accounts: {
        support: {
          ...(enabled === undefined ? {} : { enabled }),
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
    });
    expect(res.success).toBe(true);
  });

  it("keeps a disabled default bot's queue distinct from a matching logical label", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          enabled: false,
          appId: "support",
          appPassword: "primary-secret",
          webhook: { path: "/hooks/3978" },
        },
        support: {
          appId: "support-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
    });
    expect(res.success).toBe(true);
  });

  it("allows duplicate app IDs when one account is disabled", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        default: {
          appId: "shared-app-id",
          appPassword: "primary-secret",
          webhook: { path: "/hooks/3978" },
        },
        secondary: {
          enabled: false,
          appId: "shared-app-id",
          appPassword: "secondary-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("allows a named account to reuse the root app ID when accounts.default is disabled", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "shared-app-id",
      appPassword: "legacy-secret",
      tenantId: "tenant-id",
      accounts: {
        default: {
          enabled: false,
        },
        support: {
          appId: "shared-app-id",
          appPassword: "support-secret",
          webhook: { path: "/hooks/3979" },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects enabled named federated accounts without a certificate or managed identity", () => {
    const res = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      accounts: {
        secondary: {
          authType: "federated",
          appId: "secondary-app-id",
          webhook: { path: "/hooks/3979" },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("accepts enabled named federated accounts with inherited certificate config", () => {
    const res = MSTeamsConfigSchema.safeParse({
      authType: "federated",
      tenantId: "tenant-id",
      certificatePath: "/secure/secondary.pem",
      accounts: {
        secondary: {
          appId: "secondary-app-id",
          webhook: { path: "/hooks/3979" },
        },
      },
    });

    expect(res.success).toBe(true);
  });
  it("rejects an explicit path that collides with a derived named account route", () => {
    const result = MSTeamsConfigSchema.safeParse({
      tenantId: "tenant-id",
      webhook: { path: "/bots/messages" },
      accounts: {
        "Support Bot": { appId: "support-app", appPassword: "support-secret" },
        sales: {
          appId: "sales-app",
          appPassword: "sales-secret",
          webhook: { path: "/bots/messages/support-bot/" },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["accounts", "sales", "webhook", "path"],
        }),
      );
    }
  });

  it("keeps webhook.port retired while accepting explicit legacy listeners", () => {
    expect(MSTeamsConfigSchema.safeParse({ webhook: { port: 3978 } }).success).toBe(false);
    expect(MSTeamsConfigSchema.safeParse({ legacyWebhook: { port: 3978 } }).success).toBe(true);
  });
});

describe("msteams config schema", () => {
  it("rejects unsupported Teams serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGovDoD",
      serviceUrl: "https://dod.example.mil/teams",
    });

    expect(res.success).toBe(false);
  });

  it.each([undefined, "https://msteams.botframework.azure.cn/teams"])(
    "accepts China cloud with serviceUrl %s",
    (serviceUrl) => {
      const res = MSTeamsConfigSchema.safeParse({
        cloud: "China",
        serviceUrl,
      });

      expect(res.success).toBe(true);
    },
  );

  it("rejects non-China serviceUrl hosts when China cloud is configured", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "China",
      serviceUrl: "https://smba.trafficmanager.net/teams",
    });

    expect(res.success).toBe(false);
  });

  it("rejects Azure China Bot Framework serviceUrl hosts without China cloud", () => {
    const res = MSTeamsConfigSchema.safeParse({
      serviceUrl: "https://msteams.botframework.azure.cn/teams",
    });

    expect(res.success).toBe(false);
  });

  it("requires serviceUrl with non-public Teams clouds", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGov",
    });

    expect(res.success).toBe(false);
  });
});
