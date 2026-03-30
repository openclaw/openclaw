import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";
let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
type GetOAuthApiKey = typeof import("@mariozechner/pi-ai/oauth").getOAuthApiKey;

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn<GetOAuthApiKey>(async () => {
    throw new Error("Failed to extract accountId from token");
  }),
}));

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPluginMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }) => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
  buildProviderAuthDoctorHintWithPluginMock: vi.fn(async () => undefined),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: getOAuthApiKeyMock,
    getOAuthProviders: () => [
      { id: "openai-codex", envApiKey: "OPENAI_API_KEY", oauthTokenEnv: "OPENAI_OAUTH_TOKEN" }, // pragma: allowlist secret
      { id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" }, // pragma: allowlist secret
    ],
  };
});

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPlugin: formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPlugin: buildProviderAuthDoctorHintWithPluginMock,
}));

async function loadFreshOAuthModuleForTest() {
  vi.resetModules();
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
}

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
  refresh?: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access ?? "cached-access-token",
        refresh: params.refresh ?? "refresh-token",
        expires: Date.now() - 60_000,
      },
    },
  };
}

async function readStoredProfile(agentDir: string, profileId: string) {
  const raw = JSON.parse(await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8")) as {
    profiles?: Record<string, unknown>;
  };
  return raw.profiles?.[profileId] as Record<string, unknown> | undefined;
}

describe("resolveApiKeyForProfile openai-codex refresh fallback", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    resetFileLockStateForTest();
    getOAuthApiKeyMock.mockReset();
    getOAuthApiKeyMock.mockImplementation(async () => {
      throw new Error("Failed to extract accountId from token");
    });
    refreshProviderOAuthCredentialWithPluginMock.mockReset();
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
    formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
    formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
    buildProviderAuthDoctorHintWithPluginMock.mockReset();
    buildProviderAuthDoctorHintWithPluginMock.mockResolvedValue(undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-refresh-fallback-"));
    agentDir = path.join(tempRoot, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await loadFreshOAuthModuleForTest();
  });

  afterEach(async () => {
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("falls back to cached access token when openai-codex refresh fails on accountId extraction", async () => {
    const profileId = "openai-codex:default";
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async (params?: { context?: unknown }) => params?.context as never,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "cached-access-token", // pragma: allowlist secret
      provider: "openai-codex",
      email: undefined,
    });
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("keeps throwing for non-codex providers on the same refresh error", async () => {
    const profileId = "anthropic:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "anthropic",
      }),
      agentDir,
    );

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for anthropic/);
  });

  it("does not use fallback for unrelated openai-codex refresh errors", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error("invalid_grant");
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);
  });

  it("refreshes the same profile id independently across different agent auth stores", async () => {
    const profileId = "openai-codex:default";
    const workerAgentDir = path.join(tempRoot, "agents", "worker", "agent");
    await fs.mkdir(workerAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "main-stale-access-token",
        refresh: "main-refresh-token",
      }),
      agentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "worker-stale-access-token",
        refresh: "worker-refresh-token",
      }),
      workerAgentDir,
    );

    let releaseRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    getOAuthApiKeyMock.mockImplementation(async (_provider, creds) => {
      await refreshStarted;
      const refreshToken = creds["openai-codex"]?.refresh;
      if (refreshToken === "main-refresh-token") {
        return {
          apiKey: "main-fresh-access-token",
          newCredentials: {
            access: "main-fresh-access-token",
            refresh: "main-fresh-refresh-token",
            expires: Date.now() + 60_000,
          },
        };
      }
      if (refreshToken === "worker-refresh-token") {
        return {
          apiKey: "worker-fresh-access-token",
          newCredentials: {
            access: "worker-fresh-access-token",
            refresh: "worker-fresh-refresh-token",
            expires: Date.now() + 60_000,
          },
        };
      }
      throw new Error(`Unexpected refresh token: ${refreshToken ?? "missing"}`);
    });

    const mainResultPromise = resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });
    const workerResultPromise = resolveApiKeyForProfile({
      store: ensureAuthProfileStore(workerAgentDir),
      profileId,
      agentDir: workerAgentDir,
    });
    releaseRefresh?.();

    const [mainResult, workerResult] = await Promise.all([mainResultPromise, workerResultPromise]);

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(2);
    expect(mainResult).toEqual({
      apiKey: "main-fresh-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    expect(workerResult).toEqual({
      apiKey: "worker-fresh-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    await expect(readStoredProfile(agentDir, profileId)).resolves.toMatchObject({
      access: "main-fresh-access-token",
      refresh: "main-fresh-refresh-token",
    });
    await expect(readStoredProfile(workerAgentDir, profileId)).resolves.toMatchObject({
      access: "worker-fresh-access-token", // pragma: allowlist secret
      refresh: "worker-fresh-refresh-token",
    });
  });

  it("does not overwrite a profile switched to api_key while oauth refresh sync is in flight", async () => {
    const profileId = "openai-codex:default";
    let releaseRefresh: (() => void) | undefined;
    let markRefreshEntered: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshEntered = new Promise<void>((resolve) => {
      markRefreshEntered = resolve;
    });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      markRefreshEntered?.();
      await refreshStarted;
      return {
        access: "fresh-access-token",
        refresh: "fresh-refresh-token",
        expires: Date.now() + 60_000,
      } as never;
    });

    const resultPromise = resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    await refreshEntered;
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider: "openai-codex",
            key: "operator-key",
          },
        },
      },
      agentDir,
    );
    releaseRefresh?.();

    await expect(resultPromise).resolves.toEqual({
      apiKey: "fresh-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    await expect(readStoredProfile(agentDir, profileId)).resolves.toMatchObject({
      type: "api_key",
      provider: "openai-codex",
      key: "operator-key",
    });
  });

  it("reloads stored oauth credentials after refresh_token_reused and retries with the updated token", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );
    getOAuthApiKeyMock.mockImplementationOnce(async () => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "reloaded-access-token",
              refresh: "reloaded-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        agentDir,
      );
      throw new Error(
        '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","code":"refresh_token_reused"}}',
      );
    });

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "reloaded-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    await expect(readStoredProfile(agentDir, profileId)).resolves.toMatchObject({
      access: "reloaded-access-token",
      refresh: "reloaded-refresh-token",
    });
  });

  it("retries refresh once with reloaded credentials when refresh_token_reused rotates only the refresh token", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
      }),
      agentDir,
    );

    getOAuthApiKeyMock
      .mockImplementationOnce(async (_provider, creds) => {
        expect(creds["openai-codex"]?.refresh).toBe("refresh-token");
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider: "openai-codex",
                access: "still-expired-access",
                refresh: "rotated-refresh-token",
                expires: Date.now() - 5_000,
              },
            },
          },
          agentDir,
        );
        throw new Error(
          '401 {"error":{"message":"Your refresh token has already been used to generate a new access token.","code":"refresh_token_reused"}}',
        );
      })
      .mockImplementationOnce(async (_provider, creds) => {
        expect(creds["openai-codex"]?.refresh).toBe("rotated-refresh-token");
        return {
          apiKey: "retried-access-token",
          newCredentials: {
            access: "retried-access-token",
            refresh: "retried-refresh-token",
            expires: Date.now() + 60_000,
          },
        };
      });

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(getOAuthApiKeyMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      apiKey: "retried-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    await expect(readStoredProfile(agentDir, profileId)).resolves.toMatchObject({
      access: "retried-access-token",
      refresh: "retried-refresh-token",
    });
  });
});
