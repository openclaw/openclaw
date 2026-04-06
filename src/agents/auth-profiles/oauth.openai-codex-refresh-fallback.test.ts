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
import type { AuthProfileStore, OAuthCredential } from "./types.js";
let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;

const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn(async () => {
    throw new Error("Failed to extract accountId from token");
  }),
}));

const { readCodexCliCredentialsCachedMock } = vi.hoisted(() => ({
  readCodexCliCredentialsCachedMock: vi.fn<() => OAuthCredential | null>(() => null),
}));

const { writeCodexCliCredentialsMock } = vi.hoisted(() => ({
  writeCodexCliCredentialsMock: vi.fn(() => true),
}));

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
  buildProviderAuthDoctorHintWithPluginMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }): Promise<OAuthCredential | undefined> => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
  buildProviderAuthDoctorHintWithPluginMock: vi.fn(async () => undefined),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: readCodexCliCredentialsCachedMock,
  writeCodexCliCredentials: writeCodexCliCredentialsMock,
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

async function readPersistedStore(agentDir: string): Promise<AuthProfileStore> {
  return JSON.parse(
    await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
  ) as AuthProfileStore;
}

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access ?? "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
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
    readCodexCliCredentialsCachedMock.mockReset();
    readCodexCliCredentialsCachedMock.mockReturnValue(null);
    writeCodexCliCredentialsMock.mockReset();
    writeCodexCliCredentialsMock.mockReturnValue(true);
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

  it("persists plugin-refreshed openai-codex credentials before returning", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId,
        provider: "openai-codex",
        access: "stale-access-token",
      }),
      agentDir,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({
      type: "oauth",
      provider: "openai-codex",
      access: "rotated-access-token",
      refresh: "rotated-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-rotated",
    });

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "rotated-access-token",
      provider: "openai-codex",
      email: undefined,
    });

    const persisted = await readPersistedStore(agentDir);
    expect(persisted.profiles[profileId]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "rotated-access-token",
      refresh: "rotated-refresh-token",
      accountId: "acct-rotated",
    });
  });

  it("keeps throwing when expired Codex-managed credentials have no fresh fallback source", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai-codex",
            access: "expired-access-token",
            refresh: "expired-refresh-token",
            expires: Date.now() - 60_000,
          },
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValueOnce({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-cli-access-token",
      refresh: "fresh-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-cli",
    });

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for openai-codex/);

    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledTimes(1);
    expect(writeCodexCliCredentialsMock).not.toHaveBeenCalled();
  });

  it("refreshes expired Codex-managed credentials and persists them back to auth-profiles", async () => {
    const profileId = "openai-codex:default";
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai-codex",
            access: "expired-access-token",
            refresh: "expired-refresh-token",
            expires: Date.now() - 60_000,
          },
        },
      },
      agentDir,
    );
    readCodexCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "still-expired-cli-access-token",
      refresh: "still-expired-cli-refresh-token",
      expires: Date.now() - 30_000,
      accountId: "acct-cli",
    });
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValueOnce({
      type: "oauth",
      provider: "openai-codex",
      access: "rotated-cli-access-token",
      refresh: "rotated-cli-refresh-token",
      expires: Date.now() + 86_400_000,
      accountId: "acct-rotated",
    });

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "rotated-cli-access-token",
      provider: "openai-codex",
      email: undefined,
    });
    expect(writeCodexCliCredentialsMock).not.toHaveBeenCalled();

    const persisted = await readPersistedStore(agentDir);
    expect(persisted.profiles[profileId]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "rotated-cli-access-token",
      refresh: "rotated-cli-refresh-token",
      accountId: "acct-rotated",
    });
    expect(persisted.profiles[profileId]).not.toEqual(
      expect.objectContaining({
        provider: "openai-codex",
        access: "expired-access-token",
      }),
    );
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
});
