/**
 * Tests OAuth fallback to main-agent credentials.
 * Ensures agent-local auth can recover from refresh failure by adopting a fresh
 * main-store credential when identity checks allow it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "../../infra/errors.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, resetFileLockStateForTest } from "../../infra/file-lock.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { OAuthRefreshFailureError } from "./oauth-refresh-failure.js";
import { buildRefreshContentionError } from "./oauth-refresh-lock-errors.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
const { getOAuthApiKeyMock, refreshCredentialMock } = vi.hoisted(() => {
  vi.resetModules();
  return {
    getOAuthApiKeyMock: vi.fn(async () => {
      throw new Error("invalid_grant");
    }),
    refreshCredentialMock: vi.fn<
      (credential: OAuthCredential) => Promise<OAuthCredential | undefined>
    >(async () => undefined),
  };
});

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: getOAuthApiKeyMock,
  getOAuthProviders: () => [{ id: "anthropic" }, { id: "openai" }],
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  buildProviderAuthDoctorHintWithPlugin: async () => null,
  formatProviderAuthProfileApiKeyWithPlugin: async (params: { context?: { access?: string } }) =>
    params.context?.access,
  resolveProviderOAuthCredentialWithPlugin: async (params: { credential: OAuthCredential }) => {
    const credential = await refreshCredentialMock(params.credential);
    return credential
      ? { status: "available", credential, apiKey: credential.access }
      : { status: "unhandled" };
  },
  resolveProviderOAuthRefreshCapabilityWithPlugin: async () => ({ status: "unhandled" }),
}));

vi.mock("../../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  prepareProviderSyntheticAuthWithPlugin: async () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => false,
}));

afterAll(() => {
  vi.doUnmock("../../llm/oauth.js");
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
  vi.doUnmock("../../plugins/provider-external-auth-core.js");
  vi.doUnmock("../../plugins/provider-runtime.js");
  vi.resetModules();
});

function createUsableOAuthExpiry(): number {
  return Date.now() + 30 * 60 * 1000;
}

describe("resolveApiKeyForProfile fallback to main agent", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_AGENT_DIR", "OPENAI_API_KEY"]);
  let tmpDir: string;
  let mainAgentDir: string;
  let secondaryAgentDir: string;

  beforeEach(async () => {
    resetFileLockStateForTest();
    getOAuthApiKeyMock.mockReset();
    refreshCredentialMock.mockReset().mockResolvedValue(undefined);
    getOAuthApiKeyMock.mockImplementation(async () => {
      throw new Error("invalid_grant");
    });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-fallback-test-"));
    mainAgentDir = path.join(tmpDir, "agents", "main", "agent");
    secondaryAgentDir = path.join(tmpDir, "agents", "kids", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(secondaryAgentDir, { recursive: true });

    // Set environment variables so the default agent dir resolves under tmpDir.
    setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
    setTestEnvValue("OPENCLAW_AGENT_DIR", mainAgentDir);
    deleteTestEnvValue("OPENAI_API_KEY");
    clearRuntimeAuthProfileStoreSnapshots();
  });

  function createOauthStore(params: {
    profileId: string;
    access: string;
    refresh: string;
    expires: number;
    provider?: string;
  }): AuthProfileStore {
    return {
      version: 1,
      profiles: {
        [params.profileId]: {
          type: "oauth",
          provider: params.provider ?? "anthropic",
          access: params.access,
          refresh: params.refresh,
          expires: params.expires,
        },
      },
    };
  }

  function expectOauthCredentialFields(
    store: AuthProfileStore,
    profileId: string,
    params: { access: string; expires: number },
  ) {
    const credential = store.profiles[profileId];
    expect(credential?.type).toBe("oauth");
    if (credential?.type !== "oauth") {
      throw new Error(`Expected OAuth credential for ${profileId}`);
    }
    expect(credential.access).toBe(params.access);
    expect(credential.expires).toBe(params.expires);
  }

  async function writeAuthProfilesStore(agentDir: string, store: AuthProfileStore) {
    saveAuthProfileStore(store, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  }

  function readAuthProfilesStore(agentDir: string): AuthProfileStore {
    return loadPersistedAuthProfileStore(agentDir) ?? { version: 1, profiles: {} };
  }

  async function resolveFromSecondaryAgent(profileId: string) {
    const loadedSecondaryStore = ensureAuthProfileStore(secondaryAgentDir);
    return resolveApiKeyForProfile({
      store: loadedSecondaryStore,
      profileId,
      agentDir: secondaryAgentDir,
    });
  }

  afterEach(async () => {
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllGlobals();

    envSnapshot.restore();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function resolveOauthProfileForConfiguredMode(mode: "token" | "api_key") {
    const profileId = "anthropic:default";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "oauth-token",
          refresh: "refresh-token",
          expires: createUsableOAuthExpiry(),
        },
      },
    };

    const result = await resolveApiKeyForProfile({
      cfg: {
        auth: {
          profiles: {
            [profileId]: {
              provider: "anthropic",
              mode,
            },
          },
        },
      },
      store,
      profileId,
    });

    return result;
  }

  it.each([
    { expiresIn: 60_000, forceRefresh: false },
    { expiresIn: 86_400_000, forceRefresh: true },
  ])(
    "persists plugin refresh before returning ($expiresIn, forced=$forceRefresh)",
    async ({ expiresIn, forceRefresh }) => {
      const profileId = "openai:default";
      const store = createOauthStore({
        profileId,
        provider: "openai",
        access: "local-access",
        refresh: "local-refresh",
        expires: Date.now() + expiresIn,
      });
      saveAuthProfileStore(store, mainAgentDir);
      const rotated: OAuthCredential = {
        type: "oauth",
        provider: "openai",
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 86_400_000,
        accountId: "acct-rotated",
      };
      refreshCredentialMock.mockResolvedValueOnce(rotated);
      await expect(
        resolveApiKeyForProfile({ store, profileId, agentDir: mainAgentDir, forceRefresh }),
      ).resolves.toMatchObject({ apiKey: rotated.access, profileId });
      expect(refreshCredentialMock).toHaveBeenCalledOnce();
      expect(refreshCredentialMock.mock.calls[0]?.[0]).toMatchObject(store.profiles[profileId]!);
      expect(readAuthProfilesStore(mainAgentDir).profiles[profileId]).toEqual(rotated);
    },
  );

  it.each(["openai", "anthropic"])(
    "fails closed for unchanged expired %s credentials",
    async (provider) => {
      const profileId = `${provider}:default`;
      const store = createOauthStore({
        profileId,
        provider,
        access: "expired-access",
        refresh: "expired-refresh",
        expires: 1,
      });
      saveAuthProfileStore(store, mainAgentDir);
      refreshCredentialMock.mockImplementationOnce(async (credential) => credential);
      await expect(
        resolveApiKeyForProfile({ store, profileId, agentDir: mainAgentDir }),
      ).rejects.toThrow(OAuthRefreshFailureError);
      expect(refreshCredentialMock).toHaveBeenCalledOnce();
      expect(getOAuthApiKeyMock).not.toHaveBeenCalled();
      expect(readAuthProfilesStore(mainAgentDir).profiles[profileId]).toMatchObject({
        access: expect.stringContaining(":failed:access:"),
        refresh: expect.stringContaining(":failed:refresh:"),
      });
    },
  );

  it("rejects direct API-key routes before refreshing managed OAuth", async () => {
    const profileId = "openai:user@example.test";
    const store = createOauthStore({
      profileId,
      provider: "openai",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: 1,
    });
    saveAuthProfileStore(store, mainAgentDir);
    const { hasAvailableAuthForProvider, resolveApiKeyForProviderCore } =
      await import("../model-auth.js");
    const params = {
      provider: "openai",
      modelApi: "openai-responses",
      store,
      agentDir: mainAgentDir,
    };
    await expect(resolveApiKeyForProviderCore(params)).rejects.toThrow(
      'No API key found for provider "openai"',
    );
    await expect(
      resolveApiKeyForProviderCore({ ...params, profileId, lockedProfile: true }),
    ).rejects.toThrow(/requires an OpenAI API key profile/);
    await expect(hasAvailableAuthForProvider(params)).resolves.toBe(false);
    expect(refreshCredentialMock).not.toHaveBeenCalled();
    expect(getOAuthApiKeyMock).not.toHaveBeenCalled();
  });

  it("surfaces contention once without exposing the lock path", async () => {
    const profileId = "openai:default";
    const store = createOauthStore({
      profileId,
      provider: "openai",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: 1,
    });
    saveAuthProfileStore(store, mainAgentDir);
    const lockPath = path.join(mainAgentDir, "oauth-refresh.lock");
    refreshCredentialMock.mockRejectedValueOnce(
      buildRefreshContentionError({
        provider: "openai",
        profileId,
        cause: Object.assign(new Error(`file lock timeout for ${lockPath}`), {
          code: FILE_LOCK_TIMEOUT_ERROR_CODE,
          lockPath,
        }),
      }),
    );
    const failure = await resolveApiKeyForProfile({
      store,
      profileId,
      agentDir: mainAgentDir,
      forceRefresh: true,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthRefreshFailureError);
    expect(failure).toMatchObject({
      provider: "openai",
      profileId,
      reason: null,
      cause: { code: "refresh_contention", lockPath },
    });
    const message = formatErrorMessage(failure);
    expect(message.match(/OAuth token refresh failed/g)).toHaveLength(1);
    expect(message.match(/OAuth refresh failed \(refresh_contention\)/g)).toHaveLength(1);
    expect(message).not.toContain(lockPath);
    expect(message).not.toContain("file lock timeout");
  });

  it.each([false, true])(
    "clears stale lastGood and respects a locked selection ($locked)",
    async (locked) => {
      const profileId = "openai:default";
      const alternateId = "openai:user@example.test";
      const store = createOauthStore({
        profileId,
        provider: "openai",
        access: "stale-access",
        refresh: "stale-refresh",
        expires: 1,
      });
      store.profiles[alternateId] = {
        type: "oauth",
        provider: "openai",
        access: "healthy-access",
        refresh: "healthy-refresh",
        expires: createUsableOAuthExpiry(),
        email: "user@example.test",
      };
      store.lastGood = { openai: profileId };
      saveAuthProfileStore(store, mainAgentDir);
      getOAuthApiKeyMock.mockRejectedValueOnce(new Error("refresh_token_reused"));
      const { resolveApiKeyForProviderCore } = await import("../model-auth.js");
      const resolution = resolveApiKeyForProviderCore({
        provider: "openai",
        modelApi: "openai-chatgpt-responses",
        store,
        agentDir: mainAgentDir,
        profileId,
        lockedProfile: locked,
      });
      if (locked) {
        await expect(resolution).rejects.toThrow(OAuthRefreshFailureError);
      } else {
        const resolved = await resolution;
        expect(resolved).toMatchObject({
          apiKey: "healthy-access",
          profileId: alternateId,
          source: `profile:${alternateId}`,
          mode: "oauth",
        });
        expect(readAuthProfilesStore(mainAgentDir).lastGood).toBeUndefined();
        const { markAuthProfileSuccess } = await import("./profiles.js");
        await markAuthProfileSuccess({
          store: ensureAuthProfileStore(mainAgentDir),
          provider: "openai",
          profileId: alternateId,
          agentDir: mainAgentDir,
        });
        expect(readAuthProfilesStore(mainAgentDir).lastGood?.openai).toBe(alternateId);
      }
      expect(getOAuthApiKeyMock).toHaveBeenCalledOnce();
    },
  );

  it("preserves the refresh diagnosis when stale lastGood cleanup fails", async () => {
    const profileId = "openai:default";
    const store = createOauthStore({
      profileId,
      provider: "openai",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: 1,
    });
    store.lastGood = { openai: profileId };
    saveAuthProfileStore(store, mainAgentDir);
    openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveAuthProfileDatabasePath(mainAgentDir),
    }).db.exec("ALTER TABLE auth_profile_state DROP COLUMN updated_at");
    getOAuthApiKeyMock.mockRejectedValueOnce(new Error("refresh_token_reused"));
    const failure = await resolveApiKeyForProfile({
      store,
      profileId,
      agentDir: mainAgentDir,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthRefreshFailureError);
    expect(String(failure)).toContain("refresh_token_reused");
    expect(String(failure)).not.toContain("no column named updated_at");
  });

  it("falls back to main agent credentials when secondary agent token is expired and refresh fails", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000; // 1 hour ago
    const freshTime = now + 60 * 60 * 1000; // 1 hour from now

    // Write expired credentials for secondary agent
    await writeAuthProfilesStore(
      secondaryAgentDir,
      createOauthStore({
        profileId,
        access: "expired-access-token",
        refresh: "expired-refresh-token",
        expires: expiredTime,
      }),
    );

    // Write fresh credentials for main agent
    await writeAuthProfilesStore(
      mainAgentDir,
      createOauthStore({
        profileId,
        access: "fresh-access-token",
        refresh: "fresh-refresh-token",
        expires: freshTime,
      }),
    );

    // Load the secondary agent's store (will merge with main agent's store)
    // Call resolveApiKeyForProfile with the secondary agent's expired credentials:
    // fresh main credentials are used read-through without copying the refresh token.
    const result = await resolveFromSecondaryAgent(profileId);

    if (!result) {
      throw new Error("Expected fallback OAuth result from main agent");
    }
    expect(result.apiKey).toBe("fresh-access-token");
    expect(result.provider).toBe("anthropic");

    // The secondary store keeps its local credential; inherited OAuth is read-through.
    const secondaryStore = readAuthProfilesStore(secondaryAgentDir);
    expectOauthCredentialFields(secondaryStore, profileId, {
      access: "expired-access-token",
      expires: expiredTime,
    });
  });

  it("adopts newer OAuth token from main agent even when secondary token is still valid", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const secondaryExpiry = now + 30 * 60 * 1000;
    const mainExpiry = now + 2 * 60 * 60 * 1000;

    await writeAuthProfilesStore(
      secondaryAgentDir,
      createOauthStore({
        profileId,
        access: "secondary-access-token",
        refresh: "secondary-refresh-token",
        expires: secondaryExpiry,
      }),
    );

    await writeAuthProfilesStore(
      mainAgentDir,
      createOauthStore({
        profileId,
        access: "main-newer-access-token",
        refresh: "main-newer-refresh-token",
        expires: mainExpiry,
      }),
    );

    const result = await resolveFromSecondaryAgent(profileId);

    expect(result?.apiKey).toBe("main-newer-access-token");

    const secondaryStore = readAuthProfilesStore(secondaryAgentDir);
    expectOauthCredentialFields(secondaryStore, profileId, {
      access: "secondary-access-token",
      expires: secondaryExpiry,
    });
  });

  it("adopts main token when secondary expires is NaN/malformed", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const mainExpiry = now + 2 * 60 * 60 * 1000;

    await writeAuthProfilesStore(
      secondaryAgentDir,
      createOauthStore({
        profileId,
        access: "secondary-stale",
        refresh: "secondary-refresh",
        expires: Number.NaN,
      }),
    );

    await writeAuthProfilesStore(
      mainAgentDir,
      createOauthStore({
        profileId,
        access: "main-fresh-token",
        refresh: "main-refresh",
        expires: mainExpiry,
      }),
    );

    const result = await resolveFromSecondaryAgent(profileId);

    expect(result?.apiKey).toBe("main-fresh-token");
  });

  it("accepts mode=token + type=oauth for legacy compatibility", async () => {
    const result = await resolveOauthProfileForConfiguredMode("token");

    expect(result?.apiKey).toBe("oauth-token");
  });

  it("accepts mode=oauth + type=token (regression)", async () => {
    const profileId = "anthropic:default";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "token",
          provider: "anthropic",
          token: "static-token",
          expires: Date.now() + 60_000,
        },
      },
    };

    const result = await resolveApiKeyForProfile({
      cfg: {
        auth: {
          profiles: {
            [profileId]: {
              provider: "anthropic",
              mode: "oauth",
            },
          },
        },
      },
      store,
      profileId,
    });

    expect(result?.apiKey).toBe("static-token");
  });

  it("rejects true mode/type mismatches", async () => {
    const result = await resolveOauthProfileForConfiguredMode("api_key");

    expect(result).toBeNull();
  });

  it("throws error when both secondary and main agent credentials are expired", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000; // 1 hour ago

    // Write expired credentials for both agents
    const expiredStore = createOauthStore({
      profileId,
      access: "expired-access-token",
      refresh: "expired-refresh-token",
      expires: expiredTime,
    });
    await writeAuthProfilesStore(secondaryAgentDir, expiredStore);
    await writeAuthProfilesStore(mainAgentDir, expiredStore);

    // Should throw because both agents have expired credentials
    await expect(resolveFromSecondaryAgent(profileId)).rejects.toThrow(
      /OAuth token refresh failed/,
    );
  });

  it("still falls back to main agent credentials when the refresh-token-reused retry throws", async () => {
    const profileId = "anthropic:default";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000;
    const freshTime = now + 60 * 60 * 1000;

    await writeAuthProfilesStore(
      secondaryAgentDir,
      createOauthStore({
        profileId,
        access: "expired-access-token",
        refresh: "expired-refresh-token",
        expires: expiredTime,
      }),
    );

    await writeAuthProfilesStore(
      mainAgentDir,
      createOauthStore({
        profileId,
        access: "fresh-access-token",
        refresh: "fresh-refresh-token",
        expires: freshTime,
      }),
    );

    getOAuthApiKeyMock
      .mockImplementationOnce(async () => {
        throw new Error("refresh_token_reused");
      })
      .mockImplementationOnce(async () => {
        throw new Error("retry also failed");
      });

    const result = await resolveFromSecondaryAgent(profileId);

    expect(result?.apiKey).toBe("fresh-access-token");
    expect(result?.provider).toBe("anthropic");
  });
});
