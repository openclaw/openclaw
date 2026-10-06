import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureEnv } from "../../test-utils/env.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import {
  fenceOAuthRefreshPeers,
  rollbackOAuthRefreshPeerClaims,
  settleOAuthRefreshPeerClaims,
} from "./oauth-refresh-peers.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  const { resetOAuthRefreshQueuesForTest } = await import("./oauth.test-support.js");
  resetOAuthRefreshQueuesForTest();
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

function resetOAuthTestState(): void {
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks({
    refreshProviderOAuthCredentialWithPluginMock,
    formatProviderAuthProfileApiKeyWithPluginMock,
  });
  clearRuntimeAuthProfileStoreSnapshots();
}

const profileId = "openai:default";
const provider = "openai";
function candidate(agentId: string, agentDir: string) {
  return {
    configured: true,
    agentId,
    agentDir,
    databasePath: resolveAuthProfileDatabasePath(agentDir),
    env: process.env,
  };
}

function read(agentDir: string, id = profileId) {
  return loadPersistedAuthProfileStore(agentDir)?.profiles[id];
}
function resolveFrom(agentDir: string) {
  return resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
    store: ensureAuthProfileStore(agentDir),
    profileId,
    agentDir,
  });
}

let tempRoot: string;
let mainAgentDir: string;
let envSnapshot: ReturnType<typeof captureEnv>;
beforeEach(async () => {
  envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  resetOAuthTestState();
  tempRoot = await createOAuthTestTempRoot("openclaw-oauth-shard-");
  mainAgentDir = await createOAuthMainAgentDir(tempRoot);
  await loadOAuthModuleForTest();
});
afterEach(async () => {
  envSnapshot.restore();
  resetOAuthTestState();
  await removeOAuthTestTempRoot(tempRoot);
});

describe("OAuth refresh peer settlement", () => {
  it.each([["failed", createFailedOAuthRefreshFence]])(
    "does not replace a different %s fence for the same refresh generation",
    async (_, build) => {
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      await fs.mkdir(peerAgentDir, { recursive: true });
      const original = {
        type: "oauth" as const,
        provider,
        access: "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
      };
      const ownerFence = createOAuthRefreshFence({ profileId, credential: original });
      const competingFence = build(createOAuthRefreshFence({ profileId, credential: original }));
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: competingFence } }, peerAgentDir);

      await expect(
        fenceOAuthRefreshPeers({
          cfg: {},
          ownerDatabasePath: resolveAuthProfileDatabasePath(mainAgentDir),
          profileId,
          generation: original,
          fence: ownerFence,
        }),
      ).rejects.toThrow("already claimed");
      expect(read(peerAgentDir)).toEqual(competingFence);
    },
  );

  it("terminally fences peers instead of exposing a different shared account", async () => {
    const ownerAgentDir = path.join(tempRoot, "agents", "owner-a", "agent");
    const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
    await Promise.all([
      fs.mkdir(ownerAgentDir, { recursive: true }),
      fs.mkdir(peerAgentDir, { recursive: true }),
    ]);

    const accountA = createExpiredOauthStore({
      profileId,
      provider,
      accountId: "acct-a",
    });
    const accountB = createExpiredOauthStore({
      profileId,
      provider,
      access: "shared-b-access",
      refresh: "shared-b-refresh",
      accountId: "acct-b",
    });
    const sharedB = accountB.profiles[profileId];
    if (sharedB?.type !== "oauth") {
      throw new Error("expected shared OAuth credential");
    }
    sharedB.expires = Date.now() + 60 * 60 * 1000;
    saveAuthProfileStore(accountA, ownerAgentDir);
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), peerAgentDir);
    saveAuthProfileStore(accountB, mainAgentDir);
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue({
      type: "oauth",
      provider,
      access: "rotated-a-access",
      refresh: "rotated-a-refresh",
      expires: Date.now() + 60 * 60 * 1000,
      accountId: "acct-a",
    });

    await expect(resolveFrom(ownerAgentDir)).resolves.toEqual(
      expect.objectContaining({ apiKey: "rotated-a-access" }),
    );

    expect(read(mainAgentDir)).toMatchObject({
      access: "shared-b-access",
      accountId: "acct-b",
    });
    expect(read(ownerAgentDir)).toMatchObject({
      access: "rotated-a-access",
      accountId: "acct-a",
    });
    const terminalPeer = read(peerAgentDir);
    expect(terminalPeer?.type === "oauth" && isOAuthRefreshFence(terminalPeer)).toBe(true);
    expect(terminalPeer?.type === "oauth" && isPendingOAuthRefreshFence(terminalPeer)).toBe(false);
    await expect(resolveFrom(peerAgentDir)).resolves.toBeNull();
  });

  it.each([
    {
      name: "conflicting account ids despite matching email",
      provider: "openai",
      ownerIdentity: { accountId: "acct-a", email: "a@example.com" },
      peerIdentity: { accountId: "acct-b", email: "a@example.com" },
    },
    {
      name: "identity-less cross-tenant Copilot peer",
      provider: "github-copilot",
      ownerIdentity: { enterpriseUrl: "https://tenant-a.ghe.com/copilot/" },
      peerIdentity: { enterpriseUrl: "https://tenant-b.ghe.com/" },
    },
  ])(
    "terminally fences an exact replacement for $name",
    async ({ provider: peerProvider, ownerIdentity, peerIdentity }) => {
      const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
      await fs.mkdir(peerAgentDir, { recursive: true });
      const peerProfileId = `${peerProvider}:default`;
      const ownerOriginal = {
        type: "oauth" as const,
        provider: peerProvider,
        access: "cached-access-token",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
        ...ownerIdentity,
      };
      const fence = createOAuthRefreshFence({
        profileId: peerProfileId,
        credential: ownerOriginal,
      });
      const replacement = {
        ...ownerOriginal,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 3_600_000,
      };
      saveAuthProfileStore({ version: 1, profiles: { [peerProfileId]: fence } }, peerAgentDir);
      const persistedFence = read(peerAgentDir, peerProfileId);
      if (persistedFence?.type !== "oauth") {
        throw new Error("expected persisted OAuth fence");
      }
      settleOAuthRefreshPeerClaims({
        profileId: peerProfileId,
        fence: persistedFence,
        claims: [
          {
            candidate: candidate("peer-a", peerAgentDir),
            original: { ...ownerOriginal, ...peerIdentity },
          },
        ],
        authoritativeSharedCredential: replacement,
        replacement,
      });
      const settled = read(peerAgentDir, peerProfileId);
      expect(settled?.type === "oauth" && isOAuthRefreshFence(settled)).toBe(true);
      expect(settled?.type === "oauth" && isPendingOAuthRefreshFence(settled)).toBe(false);
    },
  );

  it("continues rolling back peers after one candidate cannot be restored or terminalized", async () => {
    const original = createExpiredOauthStore({ profileId, provider }).profiles[profileId];
    if (original?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    const fence = createOAuthRefreshFence({ profileId, credential: original });
    const brokenAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
    const healthyAgentDir = path.join(tempRoot, "agents", "peer-b", "agent");
    await Promise.all([
      fs.mkdir(brokenAgentDir, { recursive: true }),
      fs.mkdir(healthyAgentDir, { recursive: true }),
    ]);
    await fs.writeFile(resolveAuthProfileDatabasePath(brokenAgentDir), "not a sqlite database");
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, healthyAgentDir);
    const persistedFence = read(healthyAgentDir);
    if (persistedFence?.type !== "oauth") {
      throw new Error("expected persisted OAuth fence");
    }

    expect(() =>
      rollbackOAuthRefreshPeerClaims({
        profileId,
        fence: persistedFence,
        claims: [
          {
            candidate: candidate("peer-b", healthyAgentDir),
            original,
          },
          {
            candidate: candidate("peer-a", brokenAgentDir),
            original,
          },
        ],
      }),
    ).toThrow(AggregateError);
    expect(read(healthyAgentDir)).toMatchObject({
      type: "oauth",
      provider,
      access: original.access,
      refresh: original.refresh,
      expires: original.expires,
    });
  });

  it("terminally fences superseded peers when shared inheritance is a different account", async () => {
    const ownerAgentDir = path.join(tempRoot, "agents", "owner-a", "agent");
    const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
    await Promise.all([
      fs.mkdir(ownerAgentDir, { recursive: true }),
      fs.mkdir(peerAgentDir, { recursive: true }),
    ]);

    const accountA = createExpiredOauthStore({
      profileId,
      provider,
      accountId: "acct-a",
    });
    const accountB = createExpiredOauthStore({
      profileId,
      provider,
      access: "shared-b-access",
      refresh: "shared-b-refresh",
      accountId: "acct-b",
    });
    const sharedB = accountB.profiles[profileId];
    if (sharedB?.type !== "oauth") {
      throw new Error("expected shared OAuth credential");
    }
    sharedB.expires = Date.now() + 60 * 60 * 1000;
    saveAuthProfileStore(accountA, ownerAgentDir);
    saveAuthProfileStore(accountA, peerAgentDir);
    saveAuthProfileStore(accountB, mainAgentDir);

    const { promise: started, resolve: markStarted } = createDeferredCore();
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      markStarted();
      await finishRefreshGate;
      return undefined;
    });

    const resolving = resolveFrom(ownerAgentDir);
    await started;
    await persistAuthProfileBatch({
      agentDir: ownerAgentDir,
      profiles: [
        {
          profileId,
          credential: {
            type: "oauth",
            provider,
            access: "relogin-a-access",
            refresh: "relogin-a-refresh",
            expires: Date.now() + 60 * 60 * 1000,
            accountId: "acct-a",
          },
        },
      ],
      resetFailureState: true,
      allowOAuthGenerationReplacement: true,
    });
    finishRefresh();

    await expect(resolving).resolves.toEqual(
      expect.objectContaining({ apiKey: "relogin-a-access" }),
    );
    expect(read(mainAgentDir)).toMatchObject({
      access: "shared-b-access",
      accountId: "acct-b",
    });
    const terminalPeer = read(peerAgentDir);
    expect(terminalPeer?.type === "oauth" && isOAuthRefreshFence(terminalPeer)).toBe(true);
    expect(terminalPeer?.type === "oauth" && isPendingOAuthRefreshFence(terminalPeer)).toBe(false);
  });

  it("reports exact removal owners and preserves a reconnected peer", async () => {
    const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
    const otherAgentDir = path.join(tempRoot, "agents", "other", "agent");
    await Promise.all(
      [peerAgentDir, otherAgentDir].map((dir) => fs.mkdir(dir, { recursive: true })),
    );
    const original = createExpiredOauthStore({
      profileId,
      provider: "openai",
      accountId: "acct-a",
    });
    const replacement = createExpiredOauthStore({
      profileId,
      provider: "openai",
      access: "independent-access",
      refresh: "independent-refresh",
      accountId: "acct-b",
    });
    // Create the historical copy first; a save after the shared owner exists is inherited.
    saveAuthProfileStore(original, peerAgentDir);
    saveAuthProfileStore(original, mainAgentDir);
    saveAuthProfileStore(replacement, otherAgentDir);
    expect(read(peerAgentDir)).toEqual(original.profiles[profileId]);
    const peerScope = {
      agentDir: peerAgentDir,
      databasePath: resolveAuthProfileDatabasePath(peerAgentDir),
      profileIds: [profileId],
    };
    const beforeRemove = vi.fn(async () => {
      await persistAuthProfileBatch({
        agentDir: peerAgentDir,
        profiles: [{ profileId, credential: replacement.profiles[profileId]! }],
        allowOAuthGenerationReplacement: true,
      });
    });
    const onIncomplete = vi.fn(async () => {});

    await expect(
      removeAuthProfilesAcrossOwnerStores({
        agentDir: mainAgentDir,
        profileIds: [profileId],
        beforeRemove,
        onIncomplete,
      }),
    ).resolves.toBe(true);

    expect(beforeRemove).toHaveBeenCalledExactlyOnceWith(
      [profileId],
      [
        {
          agentDir: undefined,
          databasePath: resolveAuthProfileDatabasePath(mainAgentDir),
          profileIds: [profileId],
        },
        peerScope,
      ],
    );
    expect(read(mainAgentDir)).toBeUndefined();
    expect(read(peerAgentDir)).toEqual(replacement.profiles[profileId]);
    expect(read(otherAgentDir)).toEqual(replacement.profiles[profileId]);
    expect(onIncomplete).toHaveBeenCalledExactlyOnceWith(
      new Map([[profileId, replacement.profiles[profileId]]]),
      [peerScope],
    );
  });

  it("does not republish a refresh generation removed during provider I/O", async () => {
    const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
    await fs.mkdir(peerAgentDir, { recursive: true });

    const original = createExpiredOauthStore({
      profileId,
      provider,
      accountId: "acct-a",
    });
    saveAuthProfileStore(original, peerAgentDir);
    saveAuthProfileStore(original, mainAgentDir);
    expect(read(peerAgentDir)).toEqual(original.profiles[profileId]);

    const { promise: started, resolve: markStarted } = createDeferredCore();
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      markStarted();
      await finishRefreshGate;
      return {
        type: "oauth",
        provider,
        access: "late-rotated-access",
        refresh: "late-rotated-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "acct-a",
      } as never;
    });

    const resolving = resolveFrom(peerAgentDir);
    await started;
    await removeAuthProfilesAcrossOwnerStores({
      profileIds: [profileId],
      agentDir: mainAgentDir,
    });
    finishRefresh();

    await expect(resolving).rejects.toThrow("Failed to persist refreshed OAuth credential");
    expect(read(mainAgentDir)).toBeUndefined();
    expect(read(peerAgentDir)).toBeUndefined();
  });
});
