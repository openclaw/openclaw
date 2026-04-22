import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { __testing as externalAuthTesting } from "./external-auth.js";
import "./oauth-file-lock-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthProviders: () => [{ id: "anthropic" }, { id: "openai-codex" }],
  getOAuthApiKey: vi.fn(async (provider: string, credentials: Record<string, OAuthCredential>) => {
    const credential = credentials[provider];
    return credential
      ? {
          apiKey: credential.access,
          newCredentials: credential,
        }
      : null;
  }),
}));

async function readProfile(agentDir: string, profileId: string) {
  const raw = JSON.parse(
    await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
  ) as AuthProfileStore;
  return raw.profiles[profileId];
}

describe("OAuth refresh peer-agent broadcast (#59272)", () => {
  const envSnapshot = captureEnv([...OAUTH_AGENT_ENV_KEYS, "OPENCLAW_DISABLE_AUTH_PEER_MIRROR"]);
  let tempRoot = "";
  let caseIndex = 0;
  let stateDir = "";
  let mainAgentDir = "";

  beforeAll(async () => {
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-peer-mirror-");
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
    clearRuntimeAuthProfileStoreSnapshots();
    caseIndex += 1;
    stateDir = path.join(tempRoot, `case-${caseIndex}`);
    mainAgentDir = await createOAuthMainAgentDir(stateDir);
    resetOAuthRefreshQueuesForTest();
    delete process.env.OPENCLAW_DISABLE_AUTH_PEER_MIRROR;
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
  });

  afterAll(async () => {
    await removeOAuthTestTempRoot(tempRoot);
  });

  it("propagates refreshed credential to every peer agent that already holds the same profile", async () => {
    const profileId = "openai-codex:omar@shahine.com";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const refreshingAgentDir = path.join(stateDir, "agents", "lobster-wa", "agent");
    const peerAAgentDir = path.join(stateDir, "agents", "mail-router", "agent");
    const peerBAgentDir = path.join(stateDir, "agents", "travel-hub", "agent");
    await fs.mkdir(refreshingAgentDir, { recursive: true });
    await fs.mkdir(peerAAgentDir, { recursive: true });
    await fs.mkdir(peerBAgentDir, { recursive: true });

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId }),
      refreshingAgentDir,
    );
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId }),
      peerAAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId }),
      peerBAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "peer-broadcast-access",
          refresh: "peer-broadcast-refresh",
          expires: freshExpiry,
          accountId,
        }) as never,
    );

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(refreshingAgentDir),
      profileId,
      agentDir: refreshingAgentDir,
    });

    expect(result?.apiKey).toBe("peer-broadcast-access");

    // Main always gets the mirror (existing #26322 behavior).
    expect(await readProfile(mainAgentDir, profileId)).toMatchObject({
      access: "peer-broadcast-access",
      refresh: "peer-broadcast-refresh",
      expires: freshExpiry,
    });

    // Each peer with a matching profile id adopts the fresh credential.
    expect(await readProfile(peerAAgentDir, profileId)).toMatchObject({
      access: "peer-broadcast-access",
      refresh: "peer-broadcast-refresh",
      expires: freshExpiry,
    });
    expect(await readProfile(peerBAgentDir, profileId)).toMatchObject({
      access: "peer-broadcast-access",
      refresh: "peer-broadcast-refresh",
      expires: freshExpiry,
    });
  });

  it("does not create a profile on peers that never had one", async () => {
    const profileId = "openai-codex:omar@shahine.com";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const refreshingAgentDir = path.join(stateDir, "agents", "lobster-wa", "agent");
    const bystanderAgentDir = path.join(stateDir, "agents", "unrelated", "agent");
    await fs.mkdir(refreshingAgentDir, { recursive: true });
    await fs.mkdir(bystanderAgentDir, { recursive: true });

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId }),
      refreshingAgentDir,
    );
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);
    // Bystander has a DIFFERENT profile id — the broadcast must leave it alone.
    saveAuthProfileStore(
      createExpiredOauthStore({
        profileId: "anthropic:default",
        provider: "anthropic",
        accountId: "other",
      }),
      bystanderAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "bystander-safe-access",
          refresh: "bystander-safe-refresh",
          expires: freshExpiry,
          accountId,
        }) as never,
    );

    await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(refreshingAgentDir),
      profileId,
      agentDir: refreshingAgentDir,
    });

    const bystanderRaw = JSON.parse(
      await fs.readFile(path.join(bystanderAgentDir, "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    expect(bystanderRaw.profiles[profileId]).toBeUndefined();
    expect(bystanderRaw.profiles["anthropic:default"]).toBeDefined();
  });

  it("refuses to overwrite a peer whose profile identity regresses", async () => {
    const profileId = "openai-codex:omar@shahine.com";
    const provider = "openai-codex";
    const refreshingAccountId = "acct-omar";
    const otherAccountId = "acct-someone-else";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const refreshingAgentDir = path.join(stateDir, "agents", "lobster-wa", "agent");
    const otherIdentityAgentDir = path.join(stateDir, "agents", "other-login", "agent");
    await fs.mkdir(refreshingAgentDir, { recursive: true });
    await fs.mkdir(otherIdentityAgentDir, { recursive: true });

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: refreshingAccountId }),
      refreshingAgentDir,
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: refreshingAccountId }),
      mainAgentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider,
            access: "other-account-access",
            refresh: "other-account-refresh",
            expires: Date.now() - 60_000,
            accountId: otherAccountId,
          },
        },
      },
      otherIdentityAgentDir,
    );

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "refreshed-for-omar",
          refresh: "refreshed-for-omar-refresh",
          expires: freshExpiry,
          accountId: refreshingAccountId,
        }) as never,
    );

    await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(refreshingAgentDir),
      profileId,
      agentDir: refreshingAgentDir,
    });

    // Peer kept its distinct-identity credential — the identity guard
    // stopped the broadcast from clobbering a different account's tokens.
    expect(await readProfile(otherIdentityAgentDir, profileId)).toMatchObject({
      access: "other-account-access",
      accountId: otherAccountId,
    });
  });

  it("skips the peer broadcast when OPENCLAW_DISABLE_AUTH_PEER_MIRROR=1", async () => {
    process.env.OPENCLAW_DISABLE_AUTH_PEER_MIRROR = "1";
    const profileId = "openai-codex:omar@shahine.com";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const refreshingAgentDir = path.join(stateDir, "agents", "lobster-wa", "agent");
    const peerAgentDir = path.join(stateDir, "agents", "mail-router", "agent");
    await fs.mkdir(refreshingAgentDir, { recursive: true });
    await fs.mkdir(peerAgentDir, { recursive: true });

    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId }),
      refreshingAgentDir,
    );
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), peerAgentDir);

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "opt-out-access",
          refresh: "opt-out-refresh",
          expires: freshExpiry,
          accountId,
        }) as never,
    );

    await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(refreshingAgentDir),
      profileId,
      agentDir: refreshingAgentDir,
    });

    // Main still gets mirrored (pre-existing behavior), but the peer does NOT.
    expect(await readProfile(mainAgentDir, profileId)).toMatchObject({ access: "opt-out-access" });
    expect(await readProfile(peerAgentDir, profileId)).toMatchObject({
      access: "cached-access-token",
    });
  });

  it("broadcasts to peers when the refresh originates on the main agent", async () => {
    const profileId = "openai-codex:omar@shahine.com";
    const provider = "openai-codex";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    const peerAgentDir = path.join(stateDir, "agents", "mail-router", "agent");
    await fs.mkdir(peerAgentDir, { recursive: true });

    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), peerAgentDir);

    refreshProviderOAuthCredentialWithPluginMock.mockImplementationOnce(
      async () =>
        ({
          type: "oauth",
          provider,
          access: "main-origin-access",
          refresh: "main-origin-refresh",
          expires: freshExpiry,
          accountId,
        }) as never,
    );

    const result = await resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
      store: ensureAuthProfileStore(undefined),
      profileId,
      agentDir: undefined,
    });
    expect(result?.apiKey).toBe("main-origin-access");

    // Previously this was the exact case that leaked — main refreshes,
    // peers stay stale, and next refresh rotation invalidates the peers.
    expect(await readProfile(peerAgentDir, profileId)).toMatchObject({
      access: "main-origin-access",
      refresh: "main-origin-refresh",
      expires: freshExpiry,
    });
  });
});
