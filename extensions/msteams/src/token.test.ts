import { afterEach, describe, expect, it } from "vitest";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token.js";

const ORIGINAL_ENV = {
  appId: process.env.MSTEAMS_APP_ID,
  appPassword: process.env.MSTEAMS_APP_PASSWORD,
  tenantId: process.env.MSTEAMS_TENANT_ID,
};

afterEach(() => {
  if (ORIGINAL_ENV.appId === undefined) {
    delete process.env.MSTEAMS_APP_ID;
  } else {
    process.env.MSTEAMS_APP_ID = ORIGINAL_ENV.appId;
  }
  if (ORIGINAL_ENV.appPassword === undefined) {
    delete process.env.MSTEAMS_APP_PASSWORD;
  } else {
    process.env.MSTEAMS_APP_PASSWORD = ORIGINAL_ENV.appPassword;
  }
  if (ORIGINAL_ENV.tenantId === undefined) {
    delete process.env.MSTEAMS_TENANT_ID;
  } else {
    process.env.MSTEAMS_TENANT_ID = ORIGINAL_ENV.tenantId;
  }
});

describe("resolveMSTeamsCredentials", () => {
  it("returns configured credentials for plaintext values", () => {
    const resolved = resolveMSTeamsCredentials({
      appId: " app-id ",
      appPassword: " app-password ",
      tenantId: " tenant-id ",
    });

    expect(resolved).toEqual({
      appId: "app-id",
      appPassword: "app-password", // pragma: allowlist secret
      tenantId: "tenant-id",
      authType: "clientSecret",
    });
  });

  it("defaults to clientSecret when authType is not specified", () => {
    const resolved = resolveMSTeamsCredentials({
      appId: "app-id",
      appPassword: "secret",
      tenantId: "tenant-id",
    });

    expect(resolved?.authType).toBe("clientSecret");
  });

  it("resolves certificate credentials without appPassword", () => {
    const resolved = resolveMSTeamsCredentials({
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "certificate",
      certPemFile: "/path/to/cert.pem",
      certKeyFile: "/path/to/key.pem",
    });

    expect(resolved?.authType).toBe("certificate");
    expect(resolved?.certPemFile).toBe("/path/to/cert.pem");
    expect(resolved?.certKeyFile).toBe("/path/to/key.pem");
    expect(resolved?.appPassword).toBeUndefined();
  });

  it("resolves certificate auth without config cert fields (SDK env fallback)", () => {
    const resolved = resolveMSTeamsCredentials({
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "certificate",
    });

    expect(resolved?.authType).toBe("certificate");
    expect(resolved?.certPemFile).toBeUndefined();
    expect(resolved?.certKeyFile).toBeUndefined();
  });

  it("resolves federated credentials with ficClientId", () => {
    const resolved = resolveMSTeamsCredentials({
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federatedCredential",
      ficClientId: "fic-client-id",
    });

    expect(resolved?.authType).toBe("federatedCredential");
    expect(resolved?.ficClientId).toBe("fic-client-id");
    expect(resolved?.appPassword).toBeUndefined();
  });

  it("resolves federated credentials with widAssertionFile", () => {
    const resolved = resolveMSTeamsCredentials({
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federatedCredential",
      widAssertionFile: "/var/run/secrets/azure/tokens/azure-identity-token",
    });

    expect(resolved?.authType).toBe("federatedCredential");
    expect(resolved?.widAssertionFile).toBe("/var/run/secrets/azure/tokens/azure-identity-token");
  });

  it("resolves federated auth without config fields (SDK env fallback)", () => {
    const resolved = resolveMSTeamsCredentials({
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federatedCredential",
    });

    expect(resolved?.authType).toBe("federatedCredential");
    expect(resolved?.ficClientId).toBeUndefined();
    expect(resolved?.widAssertionFile).toBeUndefined();
  });

  it("throws when appPassword remains an unresolved SecretRef object", () => {
    expect(() =>
      resolveMSTeamsCredentials({
        appId: "app-id",
        appPassword: {
          source: "env",
          provider: "default",
          id: "MSTEAMS_APP_PASSWORD",
        },
        tenantId: "tenant-id",
      }),
    ).toThrow(/channels\.msteams\.appPassword: unresolved SecretRef/i);
  });
});

describe("hasConfiguredMSTeamsCredentials", () => {
  it("treats SecretRef appPassword as configured", () => {
    const configured = hasConfiguredMSTeamsCredentials({
      appId: "app-id",
      appPassword: {
        source: "env",
        provider: "default",
        id: "MSTEAMS_APP_PASSWORD",
      },
      tenantId: "tenant-id",
    });

    expect(configured).toBe(true);
  });

  it("detects certificate auth as configured", () => {
    expect(
      hasConfiguredMSTeamsCredentials({
        appId: "app-id",
        tenantId: "tenant-id",
        authType: "certificate",
        certPemFile: "/path/to/cert.pem",
        certKeyFile: "/path/to/key.pem",
      }),
    ).toBe(true);
  });

  it("treats certificate auth as configured even without cert files (SDK env fallback)", () => {
    expect(
      hasConfiguredMSTeamsCredentials({
        appId: "app-id",
        tenantId: "tenant-id",
        authType: "certificate",
      }),
    ).toBe(true);
  });

  it("detects federated credential auth as configured", () => {
    expect(
      hasConfiguredMSTeamsCredentials({
        appId: "app-id",
        tenantId: "tenant-id",
        authType: "federatedCredential",
        ficClientId: "fic-client-id",
      }),
    ).toBe(true);
  });

  it("treats federated auth as configured even without config fields (SDK env fallback)", () => {
    expect(
      hasConfiguredMSTeamsCredentials({
        appId: "app-id",
        tenantId: "tenant-id",
        authType: "federatedCredential",
      }),
    ).toBe(true);
  });
});
