import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { resolveAuthStorePath } from "./paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";
let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn(async () => {
    throw new Error("Failed to extract accountId from token");
  }),
}));

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPluginMock,
  readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCachedMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }) => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
  buildProviderAuthDoctorHintWithPluginMock: vi.fn(async () => undefined),
  readCodexCliCredentialsCachedMock: vi.fn(() => null),
  readMiniMaxCliCredentialsCachedMock: vi.fn(() => null),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCached: readMiniMaxCliCredentialsCachedMock,
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
  accountId?: string;
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
        accountId: params.accountId,
      },
    },
  };
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
    getOAuthApiKeyMock.mockClear();
    refreshProviderOAuthCredentialWithPluginMock.mockReset();
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
    formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
    formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
    buildProviderAuthDoctorHintWithPluginMock.mockReset();
    buildProviderAuthDoctorHintWithPluginMock.mockResolvedValue(undefined);
    readCodexCliCredentialsCachedMock.mockReset();
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
    readMiniMaxCliCredentialsCachedMock.mockReset();
    readMiniMaxCliCredentialsCachedMock.mockReturnValue(null);
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

  it("recovers from refresh_token_reused by adopting fresher main agent credentials", async () => {
    const profileId = "openai-codex:default";
    const now = Date.now();
    const freshExpiry = now + 60 * 60 * 1000;

    // Sub-agent has expired credentials
    const subAgentDir = path.join(tempRoot, "agents", "sub-a", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        accountId: "acct-shared",
      }),
      subAgentDir,
    );

    // Main agent also starts with expired credentials
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        accountId: "acct-shared",
      }),
      agentDir,
    );

    // Simulate a race: another process refreshes and writes fresh creds to the
    // main store right before our refresh attempt. The mock writes fresh creds
    // then throws refresh_token_reused (the token was already consumed).
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "fresh-access-from-main",
              refresh: "fresh-refresh-from-main",
              expires: freshExpiry,
              accountId: "acct-shared",
            },
          },
        },
        agentDir,
      );
      throw new Error(
        '401 {"error":{"message":"Your refresh token has already been used","type":"invalid_request_error","code":"refresh_token_reused"}}',
      );
    });

    clearRuntimeAuthProfileStoreSnapshots();
    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result).not.toBeNull();
    expect(result?.apiKey).toBe("fresh-access-from-main");
    expect(result?.provider).toBe("openai-codex");
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("still throws when refresh_token_reused fires and no fresh creds exist anywhere", async () => {
    const profileId = "openai-codex:default";

    // Both main and sub-agent have expired credentials
    const subAgentDir = path.join(tempRoot, "agents", "sub-b", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "openai-codex" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "openai-codex" }),
      agentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(async () => {
      throw new Error(
        '401 {"error":{"message":"Your refresh token has already been used","type":"invalid_request_error","code":"refresh_token_reused"}}',
      );
    });

    clearRuntimeAuthProfileStoreSnapshots();
    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(subAgentDir),
        profileId,
        agentDir: subAgentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);
  });

  // Task 5: verifies write-back of refreshed credentials to the main agent store
  it("writes refreshed credentials back to main agent store", async () => {
    const profileId = "openai-codex:default";
    const now = Date.now();
    const freshExpiry = now + 60 * 60 * 1000;

    // Sub-agent has expired credentials
    const subAgentDir = path.join(tempRoot, "agents", "sub-wb", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        accountId: "acct-shared",
      }),
      subAgentDir,
    );

    // Main agent also has expired credentials
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        accountId: "acct-shared",
      }),
      agentDir,
    );

    // Plugin refresh succeeds with new credentials
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider: "openai-codex",
          access: "newly-refreshed-access",
          refresh: "newly-refreshed-refresh",
          expires: freshExpiry,
          accountId: "acct-shared",
        }) as never,
    );

    clearRuntimeAuthProfileStoreSnapshots();
    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result).not.toBeNull();
    expect(result?.apiKey).toBe("newly-refreshed-access");

    // Verify write-back: main agent store should now have the fresh credentials
    const mainStoreRaw = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainStoreRaw.profiles[profileId]).toMatchObject({
      access: "newly-refreshed-access",
      expires: freshExpiry,
    });
  });

  it("does not write back refreshed credentials to main on provider-only matches", async () => {
    const profileId = "openai-codex:default";
    const now = Date.now();
    const freshExpiry = now + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-isolated", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "sub-expired-access",
        refresh: "sub-expired-refresh",
      }),
      subAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "main-expired-access",
        refresh: "main-expired-refresh",
      }),
      agentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider: "openai-codex",
          access: "sub-refreshed-access",
          refresh: "sub-refreshed-refresh",
          expires: freshExpiry,
        }) as never,
    );

    clearRuntimeAuthProfileStoreSnapshots();
    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("sub-refreshed-access");

    const mainStoreRaw = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainStoreRaw.profiles[profileId]).toMatchObject({
      access: "main-expired-access",
      refresh: "main-expired-refresh",
    });
  });

  it("refreshes inherited main-store oauth profiles without creating a local clone", async () => {
    const profileId = "openai-codex:default";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-inherited", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-subagent-only",
          },
        },
      },
      subAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        accountId: "acct-shared",
      }),
      agentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider: "openai-codex",
          access: "main-refreshed-access",
          refresh: "main-refreshed-refresh",
          expires: freshExpiry,
          accountId: "acct-shared",
        }) as never,
    );

    clearRuntimeAuthProfileStoreSnapshots();
    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    expect(result?.apiKey).toBe("main-refreshed-access");

    const mainStoreRaw = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(mainStoreRaw.profiles[profileId]).toMatchObject({
      access: "main-refreshed-access",
      refresh: "main-refreshed-refresh",
      expires: freshExpiry,
    });

    const subStoreRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(subStoreRaw.profiles[profileId]).toBeUndefined();
    expect(subStoreRaw.profiles["anthropic:default"]).toMatchObject({
      type: "api_key",
      provider: "anthropic",
      key: "sk-subagent-only",
    });
  });

  it("preserves a token re-auth that lands while refresh is in flight", async () => {
    const profileId = "openai-codex:default";
    const freshExpiry = Date.now() + 60 * 60 * 1000;
    let releaseRefresh:
      | ((value: {
          type: "oauth";
          provider: string;
          access: string;
          refresh: string;
          expires: number;
        }) => void)
      | undefined;

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "openai-codex" }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        (await new Promise<{
          type: "oauth";
          provider: string;
          access: string;
          refresh: string;
          expires: number;
        }>((resolve) => {
          releaseRefresh = resolve;
        })) as never,
    );

    clearRuntimeAuthProfileStoreSnapshots();
    const resolving = resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    await vi.waitFor(() =>
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1),
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "token",
            provider: "openai-codex",
            token: "replacement-token",
            expires: freshExpiry,
          },
        },
      },
      agentDir,
    );
    releaseRefresh?.({
      type: "oauth",
      provider: "openai-codex",
      access: "stale-refreshed-access",
      refresh: "stale-refreshed-refresh",
      expires: freshExpiry,
    });

    await expect(resolving).resolves.toEqual({
      apiKey: "replacement-token",
      provider: "openai-codex",
      email: undefined,
    });

    const currentStore = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(currentStore.profiles[profileId]).toMatchObject({
      type: "token",
      token: "replacement-token",
    });
  });

  it("re-resolves a token re-auth when refresh throws", async () => {
    const profileId = "openai-codex:default";
    const freshExpiry = Date.now() + 60 * 60 * 1000;
    let releaseRefreshError: ((error: Error) => void) | undefined;

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "openai-codex" }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        await new Promise<never>((_resolve, reject) => {
          releaseRefreshError = reject;
        }),
    );

    clearRuntimeAuthProfileStoreSnapshots();
    const resolving = resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    await vi.waitFor(() =>
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1),
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "token",
            provider: "openai-codex",
            token: "replacement-token",
            expires: freshExpiry,
          },
        },
      },
      agentDir,
    );
    releaseRefreshError?.(new Error("invalid_grant"));

    await expect(resolving).resolves.toEqual({
      apiKey: "replacement-token",
      provider: "openai-codex",
      email: undefined,
    });

    const currentStore = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(currentStore.profiles[profileId]).toMatchObject({
      type: "token",
      token: "replacement-token",
    });
  });

  it("returns freshly refreshed credentials when CAS persistence times out", async () => {
    const profileId = "openai-codex:default";
    const freshExpiry = Date.now() + 60 * 60 * 1000;
    const authPath = resolveAuthStorePath(agentDir);
    const authLockPath = `${authPath}.lock`;
    const { AUTH_STORE_LOCK_OPTIONS: liveAuthStoreLockOptions } = await import("./constants.js");
    const originalRetries = { ...liveAuthStoreLockOptions.retries };

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "openai-codex" }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider: "openai-codex",
          access: "fresh-access-after-timeout",
          refresh: "fresh-refresh-after-timeout",
          expires: freshExpiry,
        }) as never,
    );

    await fs.writeFile(
      authLockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );
    Object.assign(liveAuthStoreLockOptions.retries as Record<string, number | boolean>, {
      retries: 0,
      factor: 1,
      minTimeout: 1,
      maxTimeout: 1,
      randomize: false,
    });

    try {
      clearRuntimeAuthProfileStoreSnapshots();
      const result = await resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      });

      expect(result).toEqual({
        apiKey: "fresh-access-after-timeout",
        provider: "openai-codex",
        email: undefined,
      });

      const currentStore = JSON.parse(
        await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
      ) as AuthProfileStore;
      expect(currentStore.profiles[profileId]).toMatchObject({
        type: "oauth",
        access: "cached-access-token",
        refresh: "refresh-token",
      });
    } finally {
      Object.assign(
        liveAuthStoreLockOptions.retries as Record<string, number | boolean>,
        originalRetries,
      );
      await fs.rm(authLockPath, { force: true });
    }
  });

  it("re-resolves inherited main-store updates when refresh returns null", async () => {
    const profileId = "openai-codex:default";
    const freshExpiry = Date.now() + 60 * 60 * 1000;
    let releaseRefresh:
      | ((value: {
          type: "oauth";
          provider: string;
          access: string;
          refresh: string;
          expires: number;
          accountId?: string;
        }) => void)
      | undefined;

    const subAgentDir = path.join(tempRoot, "agents", "sub-null-reresolve", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-subagent-only",
          },
        },
      },
      subAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        accountId: "acct-shared",
      }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        (await new Promise<{
          type: "oauth";
          provider: string;
          access: string;
          refresh: string;
          expires: number;
          accountId?: string;
        }>((resolve) => {
          releaseRefresh = resolve;
        })) as never,
    );

    clearRuntimeAuthProfileStoreSnapshots();
    const resolving = resolveApiKeyForProfile({
      store: ensureAuthProfileStore(subAgentDir),
      profileId,
      agentDir: subAgentDir,
    });

    await vi.waitFor(() =>
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1),
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "token",
            provider: "openai-codex",
            token: "replacement-token",
            expires: freshExpiry,
          },
        },
      },
      agentDir,
    );
    releaseRefresh?.({
      type: "oauth",
      provider: "openai-codex",
      access: "stale-refreshed-access",
      refresh: "stale-refreshed-refresh",
      expires: freshExpiry,
      accountId: "acct-shared",
    });

    await expect(resolving).resolves.toEqual({
      apiKey: "replacement-token",
      provider: "openai-codex",
      email: undefined,
    });

    const subStoreRaw = JSON.parse(
      await fs.readFile(path.join(subAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(subStoreRaw.profiles[profileId]).toBeUndefined();
    expect(subStoreRaw.profiles["anthropic:default"]).toMatchObject({
      type: "api_key",
      provider: "anthropic",
      key: "sk-subagent-only",
    });
  });

  it("does not recreate a profile that was deleted while refresh was in flight", async () => {
    const profileId = "openai-codex:default";
    const freshExpiry = Date.now() + 60 * 60 * 1000;
    let releaseRefresh:
      | ((value: {
          type: "oauth";
          provider: string;
          access: string;
          refresh: string;
          expires: number;
        }) => void)
      | undefined;

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "openai-codex" }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        (await new Promise<{
          type: "oauth";
          provider: string;
          access: string;
          refresh: string;
          expires: number;
        }>((resolve) => {
          releaseRefresh = resolve;
        })) as never,
    );

    clearRuntimeAuthProfileStoreSnapshots();
    const resolving = resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    await vi.waitFor(() =>
      expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1),
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {},
      },
      agentDir,
    );
    releaseRefresh?.({
      type: "oauth",
      provider: "openai-codex",
      access: "stale-refreshed-access",
      refresh: "stale-refreshed-refresh",
      expires: freshExpiry,
    });

    await expect(resolving).resolves.toBeNull();

    const currentStore = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(currentStore.profiles[profileId]).toBeUndefined();
  });

  it("serializes concurrent refreshes so only one HTTP call is made", async () => {
    const profileId = "openai-codex:default";
    const now = Date.now();
    const freshExpiry = now + 60 * 60 * 1000;

    const subAgentDir = path.join(tempRoot, "agents", "sub-conc", "agent");
    await fs.mkdir(subAgentDir, { recursive: true });
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "openai-codex" }),
      subAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider: "openai-codex" }),
      agentDir,
    );

    // Plugin refresh succeeds but with a small delay to widen the race window
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(
      async () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                type: "oauth",
                provider: "openai-codex",
                access: "concurrent-refreshed-access",
                refresh: "concurrent-refreshed-refresh",
                expires: freshExpiry,
              } as never),
            50,
          ),
        ),
    );

    clearRuntimeAuthProfileStoreSnapshots();

    // Fire two concurrent resolves for the same sub-agent
    const [result1, result2] = await Promise.all([
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(subAgentDir),
        profileId,
        agentDir: subAgentDir,
      }),
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(subAgentDir),
        profileId,
        agentDir: subAgentDir,
      }),
    ]);

    // Both should succeed with the same token
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1?.apiKey).toBe("concurrent-refreshed-access");
    expect(result2?.apiKey).toBe("concurrent-refreshed-access");

    // Only one HTTP refresh should have been made
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
  });
});
