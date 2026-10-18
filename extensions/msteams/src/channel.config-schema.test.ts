import { describe, expect, it, vi } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";

describe("msteams config schema", () => {
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

  it("allows an enabled logical account id matching another bot's appId", () => {
    const res = MSTeamsConfigSchema.safeParse({
      appId: "support",
      appPassword: "primary-secret",
      tenantId: "tenant-id",
      accounts: {
        support: {
          appId: "support-app-id",
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
});

describe("msteams config schema", () => {
  it("rejects unsupported Teams serviceUrl hosts", () => {
    const res = MSTeamsConfigSchema.safeParse({
      cloud: "USGovDoD",
      serviceUrl: "https://dod.example.mil/teams",
    });

    expect(res.success).toBe(false);
  });

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
