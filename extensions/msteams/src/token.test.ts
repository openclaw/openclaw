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
import {
  hasConfiguredMSTeamsCredentials,
  resolveMSTeamsCredentials,
  type MSTeamsCredentials,
} from "./token-config.js";
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
const secret = {
  type: "secret" as const,
  appId: "app-id",
  tenantId: "tenant-id",
  appPassword: "app-pw",
};
const secretConfig = config(secret);
const certificateConfig = (overrides: Partial<MSTeamsConfig> = {}) =>
  config({ authType: "federated", ...overrides });
const federated = (
  overrides: Partial<Extract<MSTeamsCredentials, { type: "federated" }>> = {},
) => ({
  type: "federated" as const,
  appId: "app-id",
  tenantId: "tenant-id",
  certificatePath: undefined,
  useManagedIdentity: undefined,
  managedIdentityClientId: undefined,
  ...overrides,
});

type CredentialCase = [
  string,
  MSTeamsConfig | undefined,
  MSTeamsCredentials | undefined,
  Partial<Record<(typeof ENV_KEYS)[number], string>>?,
  boolean?,
];
const envSecret = {
  MSTEAMS_APP_ID: "env-app-id",
  MSTEAMS_APP_PASSWORD: "env-app-pw",
  MSTEAMS_TENANT_ID: "env-tenant-id",
};
const envFederated = { ...envSecret, MSTEAMS_AUTH_TYPE: "federated" };
const managedIdentityClientId = "  configured-managed-identity  ";

it.each<CredentialCase>([
  ["configured secret", secretConfig, secret],
  ["missing password", config(), undefined],
  ["missing configuration", undefined, undefined],
  ["incomplete environment", undefined, undefined, { MSTEAMS_APP_ID: "env-app-id" }],
  [
    "environment secret",
    undefined,
    {
      type: "secret",
      appId: "env-app-id",
      appPassword: "env-app-pw",
      tenantId: "env-tenant-id",
    },
    envSecret,
  ],
  [
    "isolated named secret",
    config({ appId: "named-app" }),
    undefined,
    { MSTEAMS_APP_PASSWORD: "default-secret" },
    false,
  ],
  ["disabled environment fallback", undefined, undefined, envSecret, false],
  ["isolated auth type", secretConfig, secret, { MSTEAMS_AUTH_TYPE: "federated" }, false],
  ["explicit secret auth type", { ...secretConfig, authType: "secret" }, secret],
  [
    "isolated named certificate",
    certificateConfig({ appId: "named-app" }),
    undefined,
    { MSTEAMS_CERTIFICATE_PATH: "/default/cert.pem" },
    false,
  ],
  [
    "blank certificate",
    certificateConfig({ certificatePath: "   " }),
    undefined,
    { MSTEAMS_CERTIFICATE_PATH: "   " },
  ],
  [
    "environment certificate preserves bytes",
    certificateConfig({ certificatePath: "   ", managedIdentityClientId }),
    federated({ certificatePath: "  /env/cert.pem  ", managedIdentityClientId }),
    {
      MSTEAMS_CERTIFICATE_PATH: "  /env/cert.pem  ",
      MSTEAMS_MANAGED_IDENTITY_CLIENT_ID: "environment-managed-identity",
    },
  ],
  [
    "configured certificate preserves bytes and precedence",
    certificateConfig({ certificatePath: "  /configured/certificate.pem  " }),
    federated({ certificatePath: "  /configured/certificate.pem  " }),
    { MSTEAMS_CERTIFICATE_PATH: "/environment/certificate.pem" },
  ],
  [
    "blank optional certificate with managed identity",
    certificateConfig({
      certificatePath: "   ",
      useManagedIdentity: true,
      managedIdentityClientId,
    }),
    federated({ useManagedIdentity: true, managedIdentityClientId }),
  ],
  [
    "environment certificate",
    undefined,
    federated({ appId: "env-app-id", tenantId: "env-tenant-id", certificatePath: "/env/cert.pem" }),
    { ...envFederated, MSTEAMS_CERTIFICATE_PATH: "/env/cert.pem" },
  ],
  [
    "system-assigned managed identity",
    certificateConfig({ useManagedIdentity: true }),
    federated({ useManagedIdentity: true }),
  ],
  [
    "environment managed identity",
    undefined,
    federated({ appId: "env-app-id", tenantId: "env-tenant-id", useManagedIdentity: true }),
    { ...envFederated, MSTEAMS_USE_MANAGED_IDENTITY: "true" },
  ],
  [
    "explicit false overrides environment managed identity",
    certificateConfig({ certificatePath: "/cert.pem", useManagedIdentity: false }),
    federated({ certificatePath: "/cert.pem" }),
    { MSTEAMS_USE_MANAGED_IDENTITY: "true" },
  ],
])("credentials: %s", (_name, cfg, expected, env = {}, allowEnvFallback = true) => {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  expect(hasConfiguredMSTeamsCredentials(cfg, { allowEnvFallback })).toBe(expected !== undefined);
  expect(resolveMSTeamsCredentials(cfg, { allowEnvFallback })).toEqual(expected);
});

it("opens the exact environment certificate path when the configured path is blank", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msteams-certificate-"));
  const certificatePath = path.join(directory, "  certificate.pem");
  try {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    writeFileSync(certificatePath, privateKey, { mode: 0o600 });
    vi.stubEnv("MSTEAMS_CERTIFICATE_PATH", certificatePath);
    const credentials = resolveMSTeamsCredentials(certificateConfig({ certificatePath: "   " }));
    expect(credentials).toMatchObject({ type: "federated", certificatePath });
    if (!credentials) {
      throw new Error("expected configured Microsoft Teams certificate credentials");
    }
    const { app } = await loadMSTeamsSdkWithAuth(credentials);
    expect(app.tokenProvider).toBeDefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

  it("persists only the selected account in SQLite and preserves legacy default tokens", async () => {
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
    expect(await delegatedState.loadMSTeamsDelegatedTokens()).toMatchObject({
      accessToken: "default-access",
      refreshToken: "refresh-token",
    });
    expect((await delegatedState.loadMSTeamsDelegatedTokens("default"))?.accessToken).toBe(
      "default-access",
    );
    expect(await delegatedState.loadMSTeamsDelegatedTokens("finance")).toBeUndefined();
    expect(existsSync(path.join(stateDir!, "state", "openclaw.sqlite"))).toBe(true);
    expect(existsSync(path.join(stateDir!, "msteams-delegated.json"))).toBe(false);
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
    const claimRefresh = delegatedState.claimMSTeamsDelegatedTokenRefresh;
    vi.spyOn(delegatedState, "claimMSTeamsDelegatedTokenRefresh").mockImplementationOnce(
      async (...args) => {
        const claim = await claimRefresh(...args);
        if (!claim) {
          throw new Error("expected real delegated claim");
        }
        return {
          ...claim,
          async settle(tokens) {
            writing.resolve();
            await releaseWrite.promise;
            if (failWrite) {
              throw new Error("synthetic storage failure");
            }
            return await claim.settle(tokens);
          },
        };
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
      failWrite ? delegatedTokens.accessToken : refreshed.accessToken,
    );
    if (failWrite) {
      // Microsoft keeps the old grant reusable; publication failure must not strand it.
      oauthTokenMocks.refreshMSTeamsDelegatedTokens.mockResolvedValueOnce(refreshed);
      expect(await resolveDelegatedAccessToken(tokenParams)).toBe(refreshed.accessToken);
      expect(oauthTokenMocks.refreshMSTeamsDelegatedTokens).toHaveBeenLastCalledWith(
        expect.objectContaining({ refreshToken: delegatedTokens.refreshToken }),
      );
      expect((await delegatedState.loadMSTeamsDelegatedTokens())?.accessToken).toBe(
        refreshed.accessToken,
      );
    }
  });

  it("propagates a delegated token read failure without attempting refresh", async () => {
    const error = new Error("synthetic storage read failure");
    vi.spyOn(delegatedState, "loadMSTeamsDelegatedTokenState").mockRejectedValueOnce(error);

    await expect(resolveDelegatedAccessToken(tokenParams)).rejects.toBe(error);
    expect(oauthTokenMocks.refreshMSTeamsDelegatedTokens).not.toHaveBeenCalled();
  });
});
