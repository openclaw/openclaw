import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";
import * as delegatedState from "./delegated-state.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { loadMSTeamsSdkWithAuth } from "./sdk.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token-config.js";
import { resolveDelegatedAccessToken } from "./token.js";

const oauthTokenMocks = vi.hoisted(() => ({
  refreshMSTeamsDelegatedTokens: vi.fn(),
}));

vi.mock("./oauth.token.js", () => ({
  refreshMSTeamsDelegatedTokens: oauthTokenMocks.refreshMSTeamsDelegatedTokens,
}));

vi.mock("openclaw/plugin-sdk/secret-input", async (importOriginal) => {
  const { normalizeOptionalString } = await import("openclaw/plugin-sdk/string-coerce-runtime");
  return {
    ...(await importOriginal<typeof import("openclaw/plugin-sdk/secret-input")>()),
    normalizeSecretInputString: normalizeOptionalString,
    normalizeResolvedSecretInputString: (opts: { value: unknown; path: string }) =>
      typeof opts.value === "string" && opts.value.trim() ? opts.value.trim() : undefined,
    hasConfiguredSecretInput: (v: unknown) => typeof v === "string" && v.trim().length > 0,
  };
});

const ENV_KEYS = [
  "MSTEAMS_APP_ID",
  "MSTEAMS_APP_PASSWORD",
  "MSTEAMS_TENANT_ID",
  "MSTEAMS_AUTH_TYPE",
  "MSTEAMS_CERTIFICATE_PATH",
  "MSTEAMS_CERTIFICATE_THUMBPRINT",
  "MSTEAMS_USE_MANAGED_IDENTITY",
  "MSTEAMS_MANAGED_IDENTITY_CLIENT_ID",
  "OPENCLAW_STATE_DIR",
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

const config = (overrides: Partial<MSTeamsConfig> = {}): MSTeamsConfig => ({
  appId: "app-id",
  tenantId: "tenant-id",
  ...overrides,
});
const secretConfig = config({ appPassword: "app-pw" });
const certificateConfig = (overrides: Partial<MSTeamsConfig> = {}) =>
  config({ authType: "federated", ...overrides });
const noEnvFallback = { allowEnvFallback: false };

function setSecretEnv() {
  process.env.MSTEAMS_APP_ID = "env-app-id";
  process.env.MSTEAMS_APP_PASSWORD = "env-app-pw";
  process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
}

describe("token – secret credentials", () => {
  it("returns true when appId + appPassword + tenantId are provided in config", () => {
    expect(hasConfiguredMSTeamsCredentials(secretConfig)).toBe(true);
  });

  it("returns false when appPassword is missing", () => {
    const cfg = { appId: "app-id", tenantId: "tenant-id" } satisfies MSTeamsConfig;
    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(false);
  });

  it("returns false when no config is given and no env vars set", () => {
    expect(hasConfiguredMSTeamsCredentials(undefined)).toBe(false);
  });

  it("returns true only when the environment provides complete secret credentials", () => {
    process.env.MSTEAMS_APP_ID = "env-app-id";
    expect(hasConfiguredMSTeamsCredentials(undefined)).toBe(false);

    process.env.MSTEAMS_APP_PASSWORD = "env-secret";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    expect(hasConfiguredMSTeamsCredentials(undefined)).toBe(true);
  });

  it("does not borrow default environment credentials when fallback is disabled", () => {
    process.env.MSTEAMS_APP_PASSWORD = "default-secret";
    const cfg = config({ appId: "named-app" });
    expect(hasConfiguredMSTeamsCredentials(cfg, noEnvFallback)).toBe(false);
  });

  it("resolves secret credentials from config", () => {
    const cfg = {
      appId: "app-id",
      appPassword: "app-pw",
      tenantId: "tenant-id",
    } satisfies MSTeamsConfig;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toEqual({
      type: "secret",
      appId: "app-id",
      appPassword: "app-pw",
      tenantId: "tenant-id",
    });
  });

  it("resolves secret credentials from env vars", () => {
    setSecretEnv();
    expect(resolveMSTeamsCredentials(undefined)).toEqual({
      type: "secret",
      appId: "env-app-id",
      appPassword: "env-app-pw",
      tenantId: "env-tenant-id",
    });
  });

  it("can disable env fallback for named accounts", () => {
    setSecretEnv();
    expect(resolveMSTeamsCredentials(undefined, noEnvFallback)).toBeUndefined();
  });

  it("does not inherit env auth type when env fallback is disabled", () => {
    process.env.MSTEAMS_AUTH_TYPE = "federated";
    const cfg = config({ appId: "named-app-id", appPassword: "named-app-pw" });
    expect(resolveMSTeamsCredentials(cfg, noEnvFallback)).toEqual({ type: "secret", ...cfg });
  });

  it("returns undefined when appPassword is missing", () => {
    expect(resolveMSTeamsCredentials(config())).toBeUndefined();
  });
});

describe("token – federated credentials (certificate)", () => {
  it("does not borrow default federated environment auth when fallback is disabled", () => {
    process.env.MSTEAMS_CERTIFICATE_PATH = "/default/cert.pem";
    const cfg = certificateConfig({ appId: "named-app" });
    expect(hasConfiguredMSTeamsCredentials(cfg, noEnvFallback)).toBe(false);
  });

  it("ignores blank certificate settings", () => {
    process.env.MSTEAMS_CERTIFICATE_PATH = "   ";
    const cfg = certificateConfig({ certificatePath: "   " });
    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(false);
    expect(resolveMSTeamsCredentials(cfg)).toBeUndefined();
  });

  it("falls back to env certificate settings without changing path bytes", () => {
    process.env.MSTEAMS_CERTIFICATE_PATH = "  /env/cert.pem  ";
    process.env.MSTEAMS_CERTIFICATE_THUMBPRINT = "environment-thumbprint";
    process.env.MSTEAMS_MANAGED_IDENTITY_CLIENT_ID = "environment-managed-identity";
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      certificatePath: "   ",
      certificateThumbprint: "  configured-thumbprint  ",
      managedIdentityClientId: "  configured-managed-identity  ",
    } satisfies MSTeamsConfig;

    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(true);
    expect(resolveMSTeamsCredentials(cfg)).toEqual({
      type: "federated",
      appId: "app-id",
      tenantId: "tenant-id",
      certificatePath: "  /env/cert.pem  ",
      useManagedIdentity: undefined,
      managedIdentityClientId: "  configured-managed-identity  ",
    });
  });

  it("opens the exact environment certificate path when the configured path is blank", async () => {
    const certificateDirectory = mkdtempSync(path.join(os.tmpdir(), "msteams-certificate-"));
    const certificatePath = path.join(certificateDirectory, "  certificate.pem");

    try {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      writeFileSync(certificatePath, privateKey, { mode: 0o600 });
      process.env.MSTEAMS_CERTIFICATE_PATH = certificatePath;

      const cfg = certificateConfig({ certificatePath: "   " });
      expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(true);
      const credentials = resolveMSTeamsCredentials(cfg);
      expect(credentials).toMatchObject({ type: "federated", certificatePath });
      if (!credentials) {
        throw new Error("expected configured Microsoft Teams certificate credentials");
      }

      const { app } = await loadMSTeamsSdkWithAuth(credentials);
      expect(app.tokenProvider).toBeDefined();
    } finally {
      rmSync(certificateDirectory, { recursive: true, force: true });
    }
  });

  it("preserves configured nonblank certificate path bytes and precedence", () => {
    process.env.MSTEAMS_CERTIFICATE_PATH = "/environment/certificate.pem";
    const certificatePath = "  /configured/certificate.pem  ";
    const cfg = certificateConfig({ certificatePath });
    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(true);
    expect(resolveMSTeamsCredentials(cfg)).toMatchObject({ certificatePath });
  });

  it("keeps managed identity configured when the optional certificate path is blank", () => {
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      certificatePath: "   ",
      useManagedIdentity: true,
      managedIdentityClientId: "  configured-managed-identity  ",
    } satisfies MSTeamsConfig;

    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(true);
    expect(resolveMSTeamsCredentials(cfg)).toEqual({
      type: "federated",
      appId: "app-id",
      tenantId: "tenant-id",
      certificatePath: undefined,
      useManagedIdentity: true,
      managedIdentityClientId: "  configured-managed-identity  ",
    });
  });

  it("resolves federated credentials from env vars", () => {
    process.env.MSTEAMS_AUTH_TYPE = "federated";
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    process.env.MSTEAMS_CERTIFICATE_PATH = "/env/cert.pem";
    process.env.MSTEAMS_CERTIFICATE_THUMBPRINT = "EEFF0011";
    const result = resolveMSTeamsCredentials(undefined);
    expect(result).toEqual({
      type: "federated",
      appId: "env-app-id",
      tenantId: "env-tenant-id",
      certificatePath: "/env/cert.pem",
      useManagedIdentity: undefined,
      managedIdentityClientId: undefined,
    });
  });
});

describe("token – federated credentials (managed identity)", () => {
  it("resolves system-assigned managed identity (no clientId)", () => {
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      useManagedIdentity: true,
    } satisfies MSTeamsConfig;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toEqual({
      type: "federated",
      appId: "app-id",
      tenantId: "tenant-id",
      certificatePath: undefined,
      useManagedIdentity: true,
      managedIdentityClientId: undefined,
    });
  });

  it("hasConfigured returns true for managed identity via env", () => {
    process.env.MSTEAMS_AUTH_TYPE = "federated";
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    process.env.MSTEAMS_USE_MANAGED_IDENTITY = "true";
    expect(hasConfiguredMSTeamsCredentials(undefined)).toBe(true);
  });

  it("config useManagedIdentity=false overrides env MSTEAMS_USE_MANAGED_IDENTITY=true", () => {
    process.env.MSTEAMS_USE_MANAGED_IDENTITY = "true";
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      certificatePath: "/cert.pem",
      useManagedIdentity: false,
    } satisfies MSTeamsConfig;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toEqual({
      type: "federated",
      appId: "app-id",
      tenantId: "tenant-id",
      certificatePath: "/cert.pem",
      useManagedIdentity: undefined,
      managedIdentityClientId: undefined,
    });
  });
});

describe("token – backward compatibility", () => {
  it("explicit authType=secret behaves same as absent", () => {
    const cfg = {
      appId: "app-id",
      appPassword: "pw",
      tenantId: "tenant-id",
      authType: "secret",
    } satisfies MSTeamsConfig;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toEqual({
      type: "secret",
      appId: "app-id",
      appPassword: "pw",
      tenantId: "tenant-id",
    });
  });
});

describe("resolveDelegatedAccessToken", () => {
  let stateDir: string | undefined;

  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
    stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-msteams-token-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    oauthTokenMocks.refreshMSTeamsDelegatedTokens.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    if (stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  const delegatedTokens = {
    accessToken: "stale-access",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 60_000,
    scopes: ["User.Read"],
  };
  const tokenParams = { tenantId: "tenant", clientId: "client", clientSecret: "secret" };
  const writeDelegatedTokens = (expiresAt: number) =>
    delegatedState.saveMSTeamsDelegatedTokens({ ...delegatedTokens, expiresAt });

  it("roundtrips delegated tokens through reopened plugin-state SQLite without a sidecar", async () => {
    await writeDelegatedTokens(Date.now() + 60_000);
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    expect(await delegatedState.loadMSTeamsDelegatedTokens()).toMatchObject({
      accessToken: "stale-access",
      refreshToken: "refresh-token",
    });
    expect(existsSync(path.join(stateDir!, "state", "openclaw.sqlite"))).toBe(true);
    expect(existsSync(path.join(stateDir!, "msteams-delegated.json"))).toBe(false);
  });

  it("reuses a valid delegated access token before expiry", async () => {
    await writeDelegatedTokens(Date.now() + 60_000);

    await expect(resolveDelegatedAccessToken(tokenParams)).resolves.toBe("stale-access");
    expect(oauthTokenMocks.refreshMSTeamsDelegatedTokens).not.toHaveBeenCalled();
  });

  it("does not reuse delegated tokens with invalid Date-range expiry", async () => {
    await writeDelegatedTokens(Number.MAX_VALUE);
    oauthTokenMocks.refreshMSTeamsDelegatedTokens.mockRejectedValueOnce(new Error("expired"));

    await expect(resolveDelegatedAccessToken(tokenParams)).resolves.toBeUndefined();
    expect(oauthTokenMocks.refreshMSTeamsDelegatedTokens).toHaveBeenCalledOnce();
  });

  it("refreshes only the selected account and preserves legacy default tokens", async () => {
    const legacyStore = createPluginStateKeyedStoreForTests<typeof delegatedTokens>("msteams", {
      namespace: "delegated-token",
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    await legacyStore.register("current", { ...delegatedTokens, accessToken: "default-access" });
    await delegatedState.saveMSTeamsDelegatedTokens(
      { ...delegatedTokens, accessToken: "support-expired", expiresAt: Date.now() - 1 },
      "support",
    );
    const refreshed = {
      ...delegatedTokens,
      accessToken: "support-refreshed",
      expiresAt: Date.now() + 60_000,
    };
    oauthTokenMocks.refreshMSTeamsDelegatedTokens.mockResolvedValueOnce(refreshed);
    const params = { ...tokenParams, clientId: "support-client", accountId: "support" };
    expect(await resolveDelegatedAccessToken(params)).toBe("support-refreshed");
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    expect((await delegatedState.loadMSTeamsDelegatedTokens("support"))?.accessToken).toBe(
      "support-refreshed",
    );
    expect((await delegatedState.loadMSTeamsDelegatedTokens("default"))?.accessToken).toBe(
      "default-access",
    );
    expect(await delegatedState.loadMSTeamsDelegatedTokens("finance")).toBeUndefined();
  });

  it.each([false, true])("awaits token persistence (write fails: %s)", async (failWrite) => {
    await writeDelegatedTokens(Date.now() - 1);
    const refreshed = {
      ...delegatedTokens,
      accessToken: "refreshed-access",
      refreshToken: "refreshed-refresh",
      expiresAt: Date.now() + 60_000,
    };
    oauthTokenMocks.refreshMSTeamsDelegatedTokens.mockResolvedValueOnce(refreshed);
    const writing = createDeferred<void>();
    const releaseWrite = createDeferred<void>();
    const saveTokens = delegatedState.saveMSTeamsDelegatedTokens;
    vi.spyOn(delegatedState, "saveMSTeamsDelegatedTokens").mockImplementationOnce(
      async (tokens) => {
        writing.resolve();
        await releaseWrite.promise;
        if (failWrite) {
          throw new Error("synthetic storage failure");
        }
        await saveTokens(tokens);
      },
    );
    let completed = false;
    const result = resolveDelegatedAccessToken(tokenParams).then((value) => {
      completed = true;
      return value;
    });

    try {
      await writing.promise;
      await Promise.resolve();
      expect(completed).toBe(false);
    } finally {
      releaseWrite.resolve();
      await result;
    }
    expect(await result).toBe(failWrite ? undefined : refreshed.accessToken);
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    expect((await delegatedState.loadMSTeamsDelegatedTokens())?.accessToken).toBe(
      failWrite ? "stale-access" : refreshed.accessToken,
    );
  });

  it("propagates a delegated token read failure without attempting refresh", async () => {
    const error = new Error("synthetic storage read failure");
    vi.spyOn(delegatedState, "loadMSTeamsDelegatedTokens").mockRejectedValueOnce(error);

    await expect(
      resolveDelegatedAccessToken({
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
      }),
    ).rejects.toBe(error);
    expect(oauthTokenMocks.refreshMSTeamsDelegatedTokens).not.toHaveBeenCalled();
  });
});
