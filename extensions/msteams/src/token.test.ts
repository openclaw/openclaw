import { afterEach, describe, expect, it } from "vitest";
import { readAccessToken } from "./token-response.js";
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
    });
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
});

describe("readAccessToken", () => {
  it("reads string and object token forms", () => {
    expect(readAccessToken("abc")).toBe("abc");
    expect(readAccessToken({ accessToken: "access-token" })).toBe("access-token");
    expect(readAccessToken({ token: "fallback-token" })).toBe("fallback-token");
  });

  it("returns null for unsupported token payloads", () => {
    expect(readAccessToken({ accessToken: 123 })).toBeNull();
    expect(readAccessToken({ token: false })).toBeNull();
    expect(readAccessToken(null)).toBeNull();
    expect(readAccessToken(undefined)).toBeNull();
  });
});
