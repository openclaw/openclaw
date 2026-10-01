import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  resetFileLockStateForTest,
} from "../../plugin-sdk/file-lock.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAuthProfileStoreFixture } from "./credential-fixtures.test-support.js";
import { isSettledOAuthRefreshFailure, OAuthRefreshFailureError } from "./oauth-refresh-failure.js";
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

  beforeEach(async () => {
    resetFileLockStateForTest();
    getOAuthApiKeyMock.mockReset();
    refreshCredentialMock.mockReset().mockResolvedValue(undefined);
    getOAuthApiKeyMock.mockImplementation(async () => {
      throw new Error("invalid_grant");
    });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-fallback-test-"));
    mainAgentDir = path.join(tmpDir, "agents", "main", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });

    // Set environment variables so the default agent dir resolves under tmpDir.
    setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
    setTestEnvValue("OPENCLAW_AGENT_DIR", mainAgentDir);
    deleteTestEnvValue("OPENAI_API_KEY");
    clearRuntimeAuthProfileStoreSnapshots();
  });

  function createOauthStore(params: {
    profileId: string;
    access?: string;
    refresh?: string;
    expires?: number;
    provider?: string;
  }): AuthProfileStore {
    return createAuthProfileStoreFixture({
      [params.profileId]: {
        type: "oauth",
        provider: params.provider ?? "openai",
        access: params.access ?? "expired-access",
        refresh: params.refresh ?? "expired-refresh",
        expires: params.expires ?? 1,
      },
    });
  }

  function readAuthProfilesStore(agentDir: string): AuthProfileStore {
    return loadPersistedAuthProfileStore(agentDir) ?? { version: 1, profiles: {} };
  }

  afterEach(async () => {
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    await cleanupSessionStateForTest({ stateDir: tmpDir });
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllGlobals();

    envSnapshot.restore();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists forced plugin refresh before returning", async () => {
    const expiresIn = 86_400_000;
    const forceRefresh = true;
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
  });

  it("fails closed for unchanged expired credentials", async () => {
    const provider = "openai";
    const profileId = `${provider}:default`;
    const store = createOauthStore({
      profileId,
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
  });

  it("rejects direct API-key routes before refreshing managed OAuth", async () => {
    const profileId = "openai:user@example.test";
    const store = createOauthStore({
      profileId,
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

  it("surfaces frozen contention once without exposing the lock path", async () => {
    const profileId = "openai:default";
    const store = createOauthStore({
      profileId,
    });
    saveAuthProfileStore(store, mainAgentDir);
    const lockPath = path.join(mainAgentDir, "oauth-refresh.lock");
    const refreshError = buildRefreshContentionError({
      provider: "openai",
      profileId,
      cause: Object.assign(new Error(`file lock timeout for ${lockPath}`), {
        code: FILE_LOCK_TIMEOUT_ERROR_CODE,
        lockPath,
      }),
    });
    refreshCredentialMock.mockRejectedValueOnce(Object.freeze(refreshError));
    const failure = await resolveApiKeyForProfile({
      store,
      profileId,
      agentDir: mainAgentDir,
      forceRefresh: true,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OAuthRefreshFailureError);
    expect(isSettledOAuthRefreshFailure(failure)).toBe(true);
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
});
