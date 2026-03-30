import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import type { AuthProfileStore } from "./types.js";
const { getOAuthApiKeyMock } = vi.hoisted(() => ({
  getOAuthApiKeyMock: vi.fn(async () => {
    throw new Error("invalid_grant");
  }),
}));

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: getOAuthApiKeyMock,
  };
});

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  buildProviderAuthDoctorHintWithPlugin: async () => null,
  formatProviderAuthProfileApiKeyWithPlugin: async (params: { context?: { access?: string } }) =>
    params.context?.access,
  refreshProviderOAuthCredentialWithPlugin: async () => null,
}));

let clearRuntimeAuthProfileStoreSnapshots: typeof import("./store.js").clearRuntimeAuthProfileStoreSnapshots;
let ensureAuthProfileStore: typeof import("./store.js").ensureAuthProfileStore;
let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;

async function loadFreshOAuthModuleForTest() {
  vi.resetModules();
  ({ clearRuntimeAuthProfileStoreSnapshots, ensureAuthProfileStore } = await import("./store.js"));
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
}

describe("resolveApiKeyForProfile fallback to main agent", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tmpDir: string;
  let mainAgentDir: string;
  let secondaryAgentDir: string;

  beforeEach(async () => {
    resetFileLockStateForTest();
    getOAuthApiKeyMock.mockReset();
    getOAuthApiKeyMock.mockImplementation(async () => {
      throw new Error("invalid_grant");
    });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-fallback-test-"));
    mainAgentDir = path.join(tmpDir, "agents", "main", "agent");
    secondaryAgentDir = path.join(tmpDir, "agents", "kids", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(secondaryAgentDir, { recursive: true });

    // Set environment variables so resolveOpenClawAgentDir() returns mainAgentDir
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    process.env.OPENCLAW_AGENT_DIR = mainAgentDir;
    process.env.PI_CODING_AGENT_DIR = mainAgentDir;
    await loadFreshOAuthModuleForTest();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  function createOauthStore(params: {
    profileId: string;
    access: string;
    refresh: string;
    expires: number;
    provider?: string;
    accountId?: string;
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
          accountId: params.accountId,
        },
      },
    };
  }

  async function writeAuthProfilesStore(agentDir: string, store: AuthProfileStore) {
    await fs.writeFile(path.join(agentDir, "auth-profiles.json"), JSON.stringify(store));
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

  it("falls back to main agent credentials when secondary agent token is expired and refresh fails", async () => {
    const profileId = "anthropic:claude-cli";
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
        accountId: "acct-shared",
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
        accountId: "acct-shared",
      }),
    );

    // Load the secondary agent's store (will merge with main agent's store)
    // Call resolveApiKeyForProfile with the secondary agent's expired credentials:
    // refresh fails, then fallback copies main credentials to secondary.
    const result = await resolveFromSecondaryAgent(profileId);

    expect(result).not.toBeNull();
    expect(result?.apiKey).toBe("fresh-access-token");
    expect(result?.provider).toBe("anthropic");

    // Verify the credentials were copied to the secondary agent
    const updatedSecondaryStore = JSON.parse(
      await fs.readFile(path.join(secondaryAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(updatedSecondaryStore.profiles[profileId]).toMatchObject({
      access: "fresh-access-token",
      expires: freshTime,
    });
  });

  it("does not inherit main agent credentials on provider-only matches", async () => {
    const profileId = "anthropic:claude-cli";
    const now = Date.now();
    const expiredTime = now - 60 * 60 * 1000;
    const freshTime = now + 60 * 60 * 1000;

    await writeAuthProfilesStore(
      secondaryAgentDir,
      createOauthStore({
        profileId,
        access: "secondary-expired-access-token",
        refresh: "secondary-expired-refresh-token",
        expires: expiredTime,
      }),
    );

    await writeAuthProfilesStore(
      mainAgentDir,
      createOauthStore({
        profileId,
        access: "main-fresh-access-token",
        refresh: "main-fresh-refresh-token",
        expires: freshTime,
      }),
    );

    await expect(resolveFromSecondaryAgent(profileId)).rejects.toThrow(
      /OAuth token refresh failed for anthropic/,
    );

    const updatedSecondaryStore = JSON.parse(
      await fs.readFile(path.join(secondaryAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(updatedSecondaryStore.profiles[profileId]).toMatchObject({
      access: "secondary-expired-access-token",
      expires: expiredTime,
    });
  });

  it("adopts newer OAuth token from main agent even when secondary token is still valid", async () => {
    const profileId = "anthropic:claude-cli";
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
        accountId: "acct-shared",
      }),
    );

    await writeAuthProfilesStore(
      mainAgentDir,
      createOauthStore({
        profileId,
        access: "main-newer-access-token",
        refresh: "main-newer-refresh-token",
        expires: mainExpiry,
        accountId: "acct-shared",
      }),
    );

    const result = await resolveFromSecondaryAgent(profileId);

    expect(result?.apiKey).toBe("main-newer-access-token");

    const updatedSecondaryStore = JSON.parse(
      await fs.readFile(path.join(secondaryAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(updatedSecondaryStore.profiles[profileId]).toMatchObject({
      access: "main-newer-access-token",
      expires: mainExpiry,
    });
  });

  it("adopts main token when secondary expires is NaN/malformed", async () => {
    const profileId = "anthropic:claude-cli";
    const now = Date.now();
    const mainExpiry = now + 2 * 60 * 60 * 1000;

    await writeAuthProfilesStore(
      secondaryAgentDir,
      createOauthStore({
        profileId,
        access: "secondary-stale",
        refresh: "secondary-refresh",
        expires: NaN,
        accountId: "acct-shared",
      }),
    );

    await writeAuthProfilesStore(
      mainAgentDir,
      createOauthStore({
        profileId,
        access: "main-fresh-token",
        refresh: "main-refresh",
        expires: mainExpiry,
        accountId: "acct-shared",
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
    const profileId = "anthropic:claude-cli";
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
});
