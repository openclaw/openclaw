// Msteams tests cover token plugin behavior.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

let savedEnv: Record<string, string | undefined> = {};

function saveAndClearEnv() {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

describe("token – secret credentials", () => {
  beforeEach(saveAndClearEnv);
  afterEach(restoreEnv);

  it("returns true when appId + appPassword + tenantId are provided in config", () => {
    const cfg = {
      appId: "app-id",
      appPassword: "app-pw",
      tenantId: "tenant-id",
    } satisfies MSTeamsConfig;
    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(true);
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
    const cfg = { appId: "named-app", tenantId: "tenant-id" } satisfies MSTeamsConfig;

    expect(hasConfiguredMSTeamsCredentials(cfg, { allowEnvFallback: false })).toBe(false);
  });

  it("resolves secret credentials from env vars", () => {
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_APP_PASSWORD = "env-app-pw";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    const result = resolveMSTeamsCredentials(undefined);
    expect(result).toEqual({
      type: "secret",
      appId: "env-app-id",
      appPassword: "env-app-pw",
      tenantId: "env-tenant-id",
    });
  });

  it("can disable env fallback for named accounts", () => {
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_APP_PASSWORD = "env-app-pw";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";

    expect(resolveMSTeamsCredentials(undefined, { allowEnvFallback: false })).toBeUndefined();
  });

  it("does not inherit env auth type when env fallback is disabled", () => {
    process.env.MSTEAMS_AUTH_TYPE = "federated";

    expect(
      resolveMSTeamsCredentials(
        {
          appId: "named-app-id",
          appPassword: "named-app-pw",
          tenantId: "tenant-id",
        } satisfies MSTeamsConfig,
        { allowEnvFallback: false },
      ),
    ).toEqual({
      type: "secret",
      appId: "named-app-id",
      appPassword: "named-app-pw",
      tenantId: "tenant-id",
    });
  });

  it("returns undefined when appPassword is missing", () => {
    const cfg = { appId: "app-id", tenantId: "tenant-id" } satisfies MSTeamsConfig;
    expect(resolveMSTeamsCredentials(cfg)).toBeUndefined();
  });
});

describe("token – federated credentials (certificate)", () => {
  beforeEach(saveAndClearEnv);
  afterEach(restoreEnv);

  it("does not borrow default federated environment auth when fallback is disabled", () => {
    process.env.MSTEAMS_CERTIFICATE_PATH = "/default/cert.pem";
    const cfg = {
      appId: "named-app",
      tenantId: "tenant-id",
      authType: "federated",
    } satisfies MSTeamsConfig;

    expect(hasConfiguredMSTeamsCredentials(cfg, { allowEnvFallback: false })).toBe(false);
  });

  it("ignores blank certificate settings", () => {
    process.env.MSTEAMS_CERTIFICATE_PATH = "   ";
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      certificatePath: "   ",
    } satisfies MSTeamsConfig;

    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(false);
    expect(resolveMSTeamsCredentials(cfg)).toBeUndefined();
  });

  it("opens the exact environment certificate path when the configured path is blank", async () => {
    const certificateDirectory = mkdtempSync(
      path.join(os.tmpdir(), "openclaw-msteams-real-certificate-"),
    );
    const certificatePath = path.join(certificateDirectory, "  certificate.pem");

    try {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      writeFileSync(certificatePath, privateKey, { mode: 0o600 });
      process.env.MSTEAMS_CERTIFICATE_PATH = certificatePath;

      const cfg = {
        appId: "app-id",
        tenantId: "tenant-id",
        authType: "federated",
        certificatePath: "   ",
      } satisfies MSTeamsConfig;

      expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(true);
      const credentials = resolveMSTeamsCredentials(cfg);
      expect(credentials).toMatchObject({
        type: "federated",
        certificatePath,
      });
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
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      certificatePath,
    } satisfies MSTeamsConfig;

    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(true);
    expect(resolveMSTeamsCredentials(cfg)).toMatchObject({ certificatePath });
  });
});

describe("token – federated credentials (managed identity)", () => {
  beforeEach(saveAndClearEnv);
  afterEach(restoreEnv);

  it("hasConfigured returns true for managed identity via env", () => {
    process.env.MSTEAMS_AUTH_TYPE = "federated";
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    process.env.MSTEAMS_USE_MANAGED_IDENTITY = "true";
    expect(hasConfiguredMSTeamsCredentials(undefined)).toBe(true);
  });
});

describe("resolveDelegatedAccessToken", () => {
  let stateDir: string | undefined;

  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
    saveAndClearEnv();
    stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-msteams-token-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    oauthTokenMocks.refreshMSTeamsDelegatedTokens.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    restoreEnv();
    if (stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  async function writeDelegatedTokens(expiresAt: number) {
    if (!stateDir) {
      throw new Error("missing stateDir");
    }
    await delegatedState.saveMSTeamsDelegatedTokens({
      accessToken: "stale-access",
      refreshToken: "refresh-token",
      expiresAt,
      scopes: ["User.Read"],
    });
  }

  const delegatedTokens = {
    accessToken: "stale-access",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 60_000,
    scopes: ["User.Read"],
  };

  it("reuses a valid delegated access token before expiry", async () => {
    await writeDelegatedTokens(Date.now() + 60_000);

    await expect(
      resolveDelegatedAccessToken({
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
      }),
    ).resolves.toBe("stale-access");
    expect(oauthTokenMocks.refreshMSTeamsDelegatedTokens).not.toHaveBeenCalled();
  });

  it("does not reuse delegated tokens with invalid Date-range expiry", async () => {
    await writeDelegatedTokens(Number.MAX_VALUE);
    oauthTokenMocks.refreshMSTeamsDelegatedTokens.mockRejectedValueOnce(new Error("expired"));

    await expect(
      resolveDelegatedAccessToken({
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
      }),
    ).resolves.toBeUndefined();
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
    expect(
      await resolveDelegatedAccessToken({
        tenantId: "tenant",
        clientId: "support-client",
        clientSecret: "secret",
        accountId: "support",
      }),
    ).toBe("support-refreshed");
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

  it.each([false, true])(
    "waits for refreshed token persistence (write fails: %s)",
    async (failWrite) => {
      await writeDelegatedTokens(Date.now() - 1);
      const refreshed = {
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: Date.now() + 60_000,
        scopes: ["User.Read"],
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
      const result = resolveDelegatedAccessToken({
        tenantId: "tenant",
        clientId: "client",
        clientSecret: "secret",
      }).then((value) => {
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
    },
  );
});
