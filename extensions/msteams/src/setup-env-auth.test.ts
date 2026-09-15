import fs from "node:fs";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msteamsSetupContract } from "./setup-core.js";

const resolveMSTeamsCredentials = vi.hoisted(() => vi.fn());
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  openclaw?: { channel?: { setup?: { fields?: Array<Record<string, unknown>> } } };
};

vi.mock("./token.js", () => ({
  hasConfiguredMSTeamsCredentials: vi.fn(),
  resolveMSTeamsCredentials,
}));

describe("msteams environment authentication setup", () => {
  beforeEach(() => {
    resolveMSTeamsCredentials.mockReset();
  });

  it("registers secret and federated environment inputs for authentication-aware validation", () => {
    const useEnv = msteamsSetupContract.metadata.fields.find((field) => field.key === "useEnv");

    expect(useEnv).toMatchObject({
      envVarMode: "any",
      envVars: [
        "MSTEAMS_APP_ID",
        "MSTEAMS_APP_PASSWORD",
        "MSTEAMS_TENANT_ID",
        "MSTEAMS_AUTH_TYPE",
        "MSTEAMS_CERTIFICATE_PATH",
        "MSTEAMS_USE_MANAGED_IDENTITY",
      ],
    });
    expect(
      packageJson.openclaw?.channel?.setup?.fields?.find((field) => field.key === "useEnv"),
    ).toEqual(useEnv);
  });

  it.each([
    {
      label: "certificate",
      existing: {
        authType: "federated" as const,
        appId: "certificate-app",
        tenantId: "tenant-id",
        certificatePath: "/secure/msteams.pem",
      },
      credentials: {
        type: "federated" as const,
        appId: "certificate-app",
        tenantId: "tenant-id",
        certificatePath: "/secure/msteams.pem",
      },
    },
    {
      label: "managed identity",
      existing: {
        authType: "federated" as const,
        appId: "managed-identity-app",
        tenantId: "tenant-id",
        useManagedIdentity: true,
        managedIdentityClientId: "managed-identity-client",
      },
      credentials: {
        type: "federated" as const,
        appId: "managed-identity-app",
        tenantId: "tenant-id",
        useManagedIdentity: true,
        managedIdentityClientId: "managed-identity-client",
      },
    },
  ])("registered --use-env preserves $label authentication", ({ existing, credentials }) => {
    resolveMSTeamsCredentials.mockReturnValue(credentials);
    const cfg = { channels: { msteams: existing } };
    const input = { useEnv: true };

    expect(
      msteamsSetupContract.validateInput?.({ cfg, accountId: DEFAULT_ACCOUNT_ID, input }),
    ).toBeNull();
    const result = msteamsSetupContract.applyAccountConfig({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      input,
    });

    const { appId, ...rootExisting } = existing;
    expect(result.channels?.msteams).toMatchObject({
      ...rootExisting,
      enabled: true,
      accounts: {
        default: {
          appId,
          enabled: true,
        },
      },
    });
    expect(result.channels?.msteams?.authType).toBe("federated");
  });

  it("switches to secret auth only for a complete explicit replacement", () => {
    resolveMSTeamsCredentials.mockReturnValue({
      type: "federated",
      appId: "old-app",
      tenantId: "tenant-id",
      useManagedIdentity: true,
    });
    const cfg = {
      channels: {
        msteams: {
          authType: "federated" as const,
          appId: "old-app",
          tenantId: "tenant-id",
          useManagedIdentity: true,
        },
      },
    };
    const input = {
      useEnv: true,
      appId: "new-app",
      appPassword: "new-password",
      tenantId: "new-tenant",
    };

    expect(
      msteamsSetupContract.validateInput?.({ cfg, accountId: DEFAULT_ACCOUNT_ID, input }),
    ).toBeNull();
    const result = msteamsSetupContract.applyAccountConfig({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      input,
    });

    expect(result.channels?.msteams?.accounts?.default).toMatchObject({
      authType: "secret",
      appId: "new-app",
      appPassword: "new-password",
      tenantId: "new-tenant",
    });
    expect(result.channels?.msteams?.accounts?.default?.useManagedIdentity).toBeUndefined();
  });
});
