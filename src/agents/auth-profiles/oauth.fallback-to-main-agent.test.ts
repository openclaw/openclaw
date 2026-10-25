import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  resetFileLockStateForTest,
} from "../../plugin-sdk/file-lock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createOAuthRefreshCredential as oauth } from "./credential-fixtures.test-support.js";
import { isSettledOAuthRefreshFailure, OAuthRefreshFailureError } from "./oauth-refresh-failure.js";
import { buildRefreshContentionError } from "./oauth-refresh-lock-errors.js";
import { resolveApiKeyForProfile as resolveProfile } from "./oauth.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import * as profiles from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";
const { getOAuthApiKeyMock, refreshCredentialMock } = vi.hoisted(() => {
  vi.resetModules();
  return {
    getOAuthApiKeyMock: vi.fn<() => Promise<never>>(),
    refreshCredentialMock:
      vi.fn<(credential: OAuthCredential) => Promise<OAuthCredential | undefined>>(),
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

// mock-isolation: OAuth fallback fixtures control stored agents and refresh results without unrelated external credentials.
vi.mock("../../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
    withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
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

describe("resolveApiKeyForProfile fallback to main agent", () => {
  let state: OpenClawTestState;
  let mainAgentDir: string;

  beforeEach(async () => {
    resetFileLockStateForTest();
    getOAuthApiKeyMock.mockReset().mockImplementation(async () => {
      throw new Error("invalid_grant");
    });
    refreshCredentialMock.mockReset().mockResolvedValue(undefined);
    state = await createOpenClawTestState({
      prefix: "oauth-fallback-test-",
      layout: "state-only",
      agentEnv: "main",
      env: { OPENAI_API_KEY: undefined },
    });
    mainAgentDir = state.agentDir();
    clearRuntimeAuthProfileStoreSnapshots();
    setRuntimeConfigSnapshot({});
  });

  function setup(
    overrides: Partial<OAuthCredential> = {},
    profileId = "openai:default",
    persist = true,
  ) {
    const store: AuthProfileStore = {
      version: 1,
      profiles: { [profileId]: oauth({ expires: 1, ...overrides }) },
    };
    if (persist) {
      saveAuthProfileStore(store, mainAgentDir);
    }
    return { store, profileId, agentDir: mainAgentDir };
  }

  function readStore(): AuthProfileStore {
    return loadPersistedAuthProfileStore(mainAgentDir) ?? { version: 1, profiles: {} };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
  });

  it("persists a forced model-auth plugin refresh before returning", async () => {
    const { getApiKeyForModelCore } = await import("../model-auth.js");
    const params = setup({ expires: Date.now() + 86_400_000 });
    const rotated = oauth({
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 86_400_000,
      accountId: "acct-rotated",
    });
    refreshCredentialMock.mockResolvedValueOnce(rotated);
    await expect(
      getApiKeyForModelCore({
        model: makeProviderModelFixture({
          id: "test-model",
          provider: "openai",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
        ...params,
        forceRefresh: true,
        lockedProfile: true,
      }),
    ).resolves.toMatchObject({ apiKey: rotated.access, profileId: params.profileId });
    expect(readStore().profiles[params.profileId]).toEqual(rotated);
  });

  it("fails closed for unchanged expired credentials", async () => {
    const params = setup();
    refreshCredentialMock.mockImplementationOnce(async (credential) => credential);
    await expect(resolveProfile(params)).rejects.toThrow(OAuthRefreshFailureError);
    expect(refreshCredentialMock).toHaveBeenCalledOnce();
    expect(getOAuthApiKeyMock).not.toHaveBeenCalled();
    expect(readStore().profiles[params.profileId]).toMatchObject({
      access: expect.stringContaining(":failed:access:"),
      refresh: expect.stringContaining(":failed:refresh:"),
    });
  });

  it("surfaces frozen contention once without exposing the lock path", async () => {
    const params = setup();
    const lockPath = path.join(mainAgentDir, "oauth-refresh.lock");
    const refreshError = buildRefreshContentionError({
      provider: "openai",
      profileId: params.profileId,
      cause: Object.assign(new Error(`file lock timeout for ${lockPath}`), {
        code: FILE_LOCK_TIMEOUT_ERROR_CODE,
        lockPath,
      }),
    });
    refreshCredentialMock.mockRejectedValueOnce(Object.freeze(refreshError));
    const failure = await resolveProfile({ ...params, forceRefresh: true }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OAuthRefreshFailureError);
    expect(isSettledOAuthRefreshFailure(failure)).toBe(true);
    expect(failure).toMatchObject({
      provider: "openai",
      profileId: params.profileId,
      reason: null,
      cause: { code: "refresh_contention", lockPath },
    });
    const message = formatErrorMessage(failure);
    expect(message.match(/OAuth token refresh failed/g)).toHaveLength(1);
    expect(message.match(/OAuth refresh failed \(refresh_contention\)/g)).toHaveLength(1);
    expect(message).not.toContain(lockPath);
    expect(message).not.toContain("file lock timeout");
  });

  it.each([false, true])("clears stale lastGood; locked=%s", async (locked) => {
    const params = setup({}, undefined, false);
    const { store, profileId } = params;
    const alternateId = "openai:user@example.test";
    store.profiles[alternateId] = oauth({
      access: "healthy-access",
      refresh: "healthy-refresh",
      expires: Date.now() + 30 * 60 * 1000,
      email: "user@example.test",
    });
    store.lastGood = { openai: profileId };
    saveAuthProfileStore(store, mainAgentDir);
    getOAuthApiKeyMock.mockRejectedValueOnce(new Error("refresh_token_reused"));
    const { resolveApiKeyForProviderCore } = await import("../model-auth.js");
    const resolution = resolveApiKeyForProviderCore({
      provider: "openai",
      modelApi: "openai-chatgpt-responses",
      ...params,
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
      expect(readStore().lastGood).toBeUndefined();
      await profiles.markAuthProfileSuccess({
        store: ensureAuthProfileStore(mainAgentDir),
        provider: "openai",
        profileId: alternateId,
        agentDir: mainAgentDir,
      });
      expect(readStore().lastGood?.openai).toBe(alternateId);
    }
    expect(getOAuthApiKeyMock).toHaveBeenCalledOnce();
  });

  it("preserves the refresh diagnosis when stale lastGood cleanup fails", async () => {
    const params = setup({}, undefined, false);
    const { store, profileId } = params;
    store.lastGood = { openai: profileId };
    saveAuthProfileStore(store, mainAgentDir);
    vi.spyOn(profiles, "clearLastGoodProfileWithLock").mockRejectedValueOnce(
      new Error("synthetic last-good cleanup failure"),
    );
    getOAuthApiKeyMock.mockRejectedValueOnce(new Error("refresh_token_reused"));
    const failure = await resolveProfile(params).catch((error: unknown) => error);
    expect(getOAuthApiKeyMock).toHaveBeenCalledOnce();
    expect(failure).toBeInstanceOf(OAuthRefreshFailureError);
    expect(String(failure)).toContain("refresh_token_reused");
    expect(String(failure)).not.toContain("synthetic last-good cleanup failure");
  });
});
