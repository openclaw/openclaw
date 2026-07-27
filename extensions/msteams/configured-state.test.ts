import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { hasConfiguredMSTeamsChannelState } from "./configured-state.js";

const requiredEnv = {
  MSTEAMS_APP_ID: "teams-app",
  MSTEAMS_TENANT_ID: "teams-tenant",
};

describe("Microsoft Teams lightweight configured-state", () => {
  it.each([
    {
      label: "default client-secret credentials",
      env: { ...requiredEnv, MSTEAMS_APP_PASSWORD: "teams-secret" },
      configured: true,
    },
    {
      label: "a certificate without federated mode",
      env: { ...requiredEnv, MSTEAMS_CERTIFICATE_PATH: "/teams.pem" },
      configured: false,
    },
    {
      label: "a managed identity without federated mode",
      env: { ...requiredEnv, MSTEAMS_USE_MANAGED_IDENTITY: "true" },
      configured: false,
    },
    {
      label: "a federated certificate",
      env: {
        ...requiredEnv,
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_CERTIFICATE_PATH: "/teams.pem",
      },
      configured: true,
    },
    {
      label: "a whitespace-only federated certificate",
      env: {
        ...requiredEnv,
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_CERTIFICATE_PATH: "   ",
      },
      configured: false,
    },
    {
      label: "an enabled federated managed identity",
      env: {
        ...requiredEnv,
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_USE_MANAGED_IDENTITY: "true",
      },
      configured: true,
    },
    {
      label: "a disabled federated managed identity",
      env: {
        ...requiredEnv,
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_USE_MANAGED_IDENTITY: "false",
      },
      configured: false,
    },
    {
      label: "federated mode without an authentication mechanism",
      env: { ...requiredEnv, MSTEAMS_AUTH_TYPE: "federated" },
      configured: false,
    },
    {
      label: "a missing tenant",
      env: { MSTEAMS_APP_ID: "teams-app", MSTEAMS_APP_PASSWORD: "teams-secret" },
      configured: false,
    },
  ])("recognizes $label", ({ env, configured }) => {
    expect(hasConfiguredMSTeamsChannelState({ cfg: {}, env })).toBe(configured);
  });

  it.each([
    {
      label: "ambient client-secret credentials",
      cfg: { channels: { msteams: { enabled: false } } } satisfies OpenClawConfig,
      env: { ...requiredEnv, MSTEAMS_APP_PASSWORD: "teams-secret" },
    },
    {
      label: "configured client-secret credentials",
      cfg: {
        channels: {
          msteams: {
            enabled: false,
            appId: "teams-app",
            tenantId: "teams-tenant",
            appPassword: "teams-secret",
          },
        },
      } satisfies OpenClawConfig,
      env: {},
    },
    {
      label: "ambient federated managed-identity credentials",
      cfg: { channels: { msteams: { enabled: false } } } satisfies OpenClawConfig,
      env: {
        ...requiredEnv,
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_USE_MANAGED_IDENTITY: "true",
      },
    },
  ])("rejects $label when the sole Teams account is disabled", ({ cfg, env }) => {
    expect(hasConfiguredMSTeamsChannelState({ cfg, env })).toBe(false);
  });

  it("recognizes configured client-secret references", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          appId: "teams-app",
          tenantId: "teams-tenant",
          appPassword: {
            source: "env",
            provider: "default",
            id: "TEAMS_SECRET",
          },
        },
      },
    };

    expect(hasConfiguredMSTeamsChannelState({ cfg, env: {} })).toBe(true);
  });

  it("lets an explicit disabled identity override an ambient enabled identity", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          appId: "teams-app",
          tenantId: "teams-tenant",
          authType: "federated",
          useManagedIdentity: false,
        },
      },
    };

    expect(
      hasConfiguredMSTeamsChannelState({
        cfg,
        env: { MSTEAMS_USE_MANAGED_IDENTITY: "true" },
      }),
    ).toBe(false);
  });

  it("rejects a whitespace-only configured certificate path", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          appId: "teams-app",
          tenantId: "teams-tenant",
          authType: "federated",
          certificatePath: "   ",
        },
      },
    };

    expect(hasConfiguredMSTeamsChannelState({ cfg, env: {} })).toBe(false);
  });
});
