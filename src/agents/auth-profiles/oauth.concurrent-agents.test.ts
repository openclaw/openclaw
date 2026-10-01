import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../plugin-sdk/file-lock.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { captureEnv } from "../../test-utils/env.js";
import { AUTH_STORE_VERSION, MINIMAX_CLI_PROFILE_ID } from "./constants.js";
import "./oauth-external-auth-passthrough.test-support.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import {
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import { failOAuthRefreshPeerClaims, fenceOAuthRefreshPeers } from "./oauth-refresh-peers.js";
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
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store-runtime.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "./store.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.test-support.js").resetOAuthRefreshQueuesForTest;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  ({ resetOAuthRefreshQueuesForTest } = await import("./oauth.test-support.js"));
  resetOAuthRefreshQueuesForTest();
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }, { id: "minimax-portal" }],
}));

const profileId = "openai:default";
const provider = "openai";
function candidate(agentId: string, agentDir: string) {
  return {
    agentId,
    agentDir,
    databasePath: resolveAuthProfileDatabasePath(agentDir),
    env: process.env,
  };
}

function read(agentDir: string | undefined) {
  assert.ok(agentDir, "expected a seeded agent directory");
  return loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
}
function resolveFrom(agentDir: string | undefined) {
  assert.ok(agentDir, "expected a seeded agent directory");
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
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks({
    refreshProviderOAuthCredentialWithPluginMock,
    formatProviderAuthProfileApiKeyWithPluginMock,
  });
  clearRuntimeAuthProfileStoreSnapshots();
  tempRoot = await createOAuthTestTempRoot("openclaw-oauth-shard-");
  mainAgentDir = await createOAuthMainAgentDir(tempRoot);
  await loadOAuthModuleForTest();
});
afterEach(async () => {
  envSnapshot.restore();
  resetFileLockStateForTest();
  resetOAuthProviderRuntimeMocks({
    refreshProviderOAuthCredentialWithPluginMock,
    formatProviderAuthProfileApiKeyWithPluginMock,
  });
  clearRuntimeAuthProfileStoreSnapshots();
  await removeOAuthTestTempRoot(tempRoot);
});

describe("resolveApiKeyForProfile cross-agent refresh coordination (#26322)", () => {
  it("gives one copied refresh generation one durable main-store owner", async () => {
    const freshExpiry = Date.now() + 60 * 60 * 1000;
    const subAgents = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const dir = path.join(tempRoot, "agents", `sub-${i}`, "agent");
        await fs.mkdir(dir, { recursive: true });
        const local = createExpiredOauthStore({ profileId, provider, accountId: "acct-a" });
        const credential = local.profiles[profileId];
        if (credential?.type === "oauth") {
          // Access and expiry can drift while the single-use refresh generation stays shared.
          credential.access = `local-drifted-access-${i}`;
          credential.expires = Date.now() - 1_000;
          if (i === 2) {
            delete credential.accountId;
          }
          if (i === 3) {
            credential.refresh = "independent-refresh-generation";
            credential.access = "independent-access";
            credential.expires = freshExpiry;
          } else if (i === 4) {
            credential.copyToAgents = true;
            credential.access = "portable-access";
            credential.expires = freshExpiry;
          }
        }
        local.order = { openai: [profileId] };
        local.usageStats = { [profileId]: { lastUsed: i + 1 } };
        saveAuthProfileStore(local, dir);
        return dir;
      }),
    );
    const mainStore = createExpiredOauthStore({ profileId, provider, accountId: "acct-a" });
    const mainCredential = mainStore.profiles[profileId];
    if (mainCredential?.type === "oauth") {
      mainCredential.access = "main-drifted-access";
    }
    saveAuthProfileStore(mainStore, mainAgentDir);

    let callCount = 0;
    const { promise: started, resolve: markStarted } = createDeferredCore();
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      callCount += 1;
      markStarted();
      await finishRefreshGate;
      return {
        type: "oauth",
        provider,
        access: "cross-agent-refreshed-access",
        refresh: "cross-agent-refreshed-refresh",
        expires: freshExpiry,
        accountId: "acct-a",
      } as never;
    });

    const first = resolveFrom(subAgents[0]);
    await started;
    expect(
      resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: subAgents[2],
        profileId,
      }),
    ).toBeUndefined();
    expect(callCount).toBe(1);
    for (const agentDir of subAgents.slice(0, 3)) {
      const fenced = read(agentDir);
      expect(fenced?.type === "oauth" ? fenced.access : "").toMatch(
        /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:access:[a-f0-9]{64}$/,
      );
      expect(fenced?.type === "oauth" ? fenced.refresh : "").toMatch(
        /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:refresh:[a-f0-9]{64}$/,
      );
    }
    expect(read(subAgents[3])).toMatchObject({
      refresh: "independent-refresh-generation",
    });
    expect(read(subAgents[4])).toMatchObject({
      copyToAgents: true,
      refresh: "refresh-token",
    });

    finishRefresh();
    await expect(first).resolves.toEqual(
      expect.objectContaining({
        apiKey: "cross-agent-refreshed-access",
        provider,
      }),
    );
    expect(callCount).toBe(1);
    for (const [index, agentDir] of subAgents.slice(0, 3).entries()) {
      const persisted = loadPersistedAuthProfileStore(agentDir);
      expect(persisted?.profiles[profileId]).toBeUndefined();
      expect(persisted?.order?.openai).toEqual([profileId]);
      expect(persisted?.usageStats?.[profileId]?.lastUsed).toBe(index + 1);
    }
    expect(read(subAgents[3])).toMatchObject({
      access: "independent-access",
      refresh: "independent-refresh-generation",
    });
    expect(read(subAgents[4])).toMatchObject({
      access: "portable-access",
      copyToAgents: true,
    });

    await removeAuthProfilesAcrossOwnerStores({
      profileIds: [profileId],
      agentDir: mainAgentDir,
    });
    await expect(resolveFrom(subAgents[2])).resolves.toBeNull();
    clearRuntimeAuthProfileStoreSnapshots();
    await expect(resolveFrom(subAgents[2])).resolves.toBeNull();
    expect(callCount).toBe(1);
    await expect(resolveFrom(subAgents[3])).resolves.toEqual(
      expect.objectContaining({ apiKey: "independent-access" }),
    );
    await expect(resolveFrom(subAgents[4])).resolves.toEqual(
      expect.objectContaining({ apiKey: "portable-access" }),
    );
  }, 10_000);

  it("keeps pending observers read-only until the owner claims a late peer", async () => {
    const latePeerAgentDir = path.join(tempRoot, "agents", "late-peer", "agent");
    await fs.mkdir(latePeerAgentDir, { recursive: true });
    const originalStore = createExpiredOauthStore({
      profileId,
      provider,
      accountId: "acct-a",
    });
    const original = originalStore.profiles[profileId];
    if (original?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    saveAuthProfileStore(originalStore, mainAgentDir);

    const { promise: refreshStarted, resolve: markRefreshStarted } = createDeferredCore();
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    const refreshCredential = vi.fn(async () => {
      markRefreshStarted();
      await finishRefreshGate;
      return {
        type: "oauth" as const,
        provider,
        access: "rotated-a-access",
        refresh: "rotated-a-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "acct-a",
      };
    });
    const createManager = (onBootstrap?: () => void) =>
      createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        refreshCredential,
        canRefreshCredential: async () => true,
        readBootstrapCredential: () => {
          onBootstrap?.();
          return null;
        },
      });

    const owner = createManager().resolveOAuthAccess({
      store: ensureAuthProfileStore(mainAgentDir),
      profileId,
      credential: original,
      agentDir: mainAgentDir,
    });
    await refreshStarted;
    writePersistedAuthProfileStoreRaw(originalStore, latePeerAgentDir);

    const { promise: observerEntered, resolve: markObserverEntered } = createDeferredCore();
    const observer = createManager(markObserverEntered).resolveOAuthAccess({
      store: ensureAuthProfileStore(mainAgentDir),
      profileId,
      credential: original,
      agentDir: mainAgentDir,
    });
    await observerEntered;
    await withOAuthProfileLock({ provider, profileId }, async () => {});

    expect(read(latePeerAgentDir)).toEqual(original);
    expect(refreshCredential).toHaveBeenCalledOnce();

    finishRefresh();
    await expect(owner).resolves.toEqual(expect.objectContaining({ apiKey: "rotated-a-access" }));
    await expect(observer).resolves.toEqual(
      expect.objectContaining({ apiKey: "rotated-a-access" }),
    );
    expect(read(latePeerAgentDir)).toBeUndefined();
  });

  it("allows only one independent manager to own a late local refresh generation", async () => {
    const firstAgentDir = path.join(tempRoot, "agents", "first", "agent");
    const secondAgentDir = path.join(tempRoot, "agents", "second", "agent");
    await Promise.all([
      fs.mkdir(firstAgentDir, { recursive: true }),
      fs.mkdir(secondAgentDir, { recursive: true }),
    ]);
    const originalStore = createExpiredOauthStore({
      profileId,
      provider,
      accountId: "acct-a",
    });
    const original = originalStore.profiles[profileId];
    if (original?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    saveAuthProfileStore(originalStore, firstAgentDir);

    const { promise: firstRefreshStarted, resolve: markFirstRefreshStarted } = createDeferredCore();
    const { promise: finishFirstRefreshGate, resolve: finishFirstRefresh } = createDeferredCore();
    const refreshCredential = vi.fn(async () => {
      if (refreshCredential.mock.calls.length === 1) {
        markFirstRefreshStarted();
        await finishFirstRefreshGate;
      }
      return {
        type: "oauth" as const,
        provider,
        access: "rotated-a-access",
        refresh: "rotated-a-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "acct-a",
      };
    });
    const createManager = () =>
      createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        refreshCredential,
        canRefreshCredential: async () => true,
        readBootstrapCredential: () => null,
      });

    const first = createManager().resolveOAuthAccess({
      store: ensureAuthProfileStore(firstAgentDir),
      profileId,
      credential: original,
      agentDir: firstAgentDir,
    });
    await firstRefreshStarted;
    const firstFence = read(firstAgentDir);
    expect(firstFence?.type === "oauth" && isPendingOAuthRefreshFence(firstFence)).toBe(true);

    writePersistedAuthProfileStoreRaw(originalStore, secondAgentDir);
    await expect(
      createManager().resolveOAuthAccess({
        store: ensureAuthProfileStore(secondAgentDir),
        profileId,
        credential: original,
        agentDir: secondAgentDir,
      }),
    ).rejects.toThrow("historical OAuth refresh peer");

    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(read(firstAgentDir)).toEqual(firstFence);
    expect(read(secondAgentDir)).toEqual(original);

    finishFirstRefresh();
    await expect(first).resolves.toEqual(expect.objectContaining({ apiKey: "rotated-a-access" }));
    expect(read(secondAgentDir)).toBeUndefined();
  });

  it("continues terminalizing peers after one candidate update fails", async () => {
    const original = createExpiredOauthStore({ profileId, provider }).profiles[profileId];
    if (original?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    const fence = createOAuthRefreshFence({ profileId, credential: original });
    const unreadableAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
    const readableAgentDir = path.join(tempRoot, "agents", "peer-b", "agent");
    await fs.mkdir(unreadableAgentDir, { recursive: true });
    await fs.mkdir(readableAgentDir, { recursive: true });
    await fs.writeFile(resolveAuthProfileDatabasePath(unreadableAgentDir), "not a sqlite database");
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, readableAgentDir);
    const persistedFence = read(readableAgentDir);
    if (persistedFence?.type !== "oauth") {
      throw new Error("expected persisted OAuth fence");
    }

    expect(() =>
      failOAuthRefreshPeerClaims({
        profileId,
        fence: persistedFence,
        claims: [
          {
            candidate: candidate("peer-a", unreadableAgentDir),
          },
          {
            candidate: candidate("peer-b", readableAgentDir),
          },
        ],
      }),
    ).toThrow();
    const terminal = read(readableAgentDir);
    expect(terminal?.type === "oauth" && isOAuthRefreshFence(terminal)).toBe(true);
    expect(terminal?.type === "oauth" && isPendingOAuthRefreshFence(terminal)).toBe(false);
  });

  it("rejects a same-generation login write while refresh owns the generation", async () => {
    const original = createExpiredOauthStore({ profileId, provider });
    saveAuthProfileStore(original, mainAgentDir);

    const { promise: started, resolve: markStarted } = createDeferredCore();
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      markStarted();
      await finishRefreshGate;
      return {
        type: "oauth",
        provider,
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60 * 60 * 1000,
      } as never;
    });

    const resolving = resolveFrom(mainAgentDir);
    await started;
    const originalCredential = original.profiles[profileId];
    if (originalCredential?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    await expect(
      persistAuthProfileBatch({
        agentDir: mainAgentDir,
        profiles: [{ profileId, credential: originalCredential }],
        resetFailureState: true,
        allowOAuthGenerationReplacement: true,
      }),
    ).rejects.toThrow("Refused to restore fenced OAuth refresh generation");
    const ownerFence = read(mainAgentDir);
    expect(ownerFence?.type === "oauth" && isOAuthRefreshFence(ownerFence)).toBe(true);

    finishRefresh();
    await expect(resolving).resolves.toEqual(expect.objectContaining({ apiKey: "rotated-access" }));
    expect(read(mainAgentDir)).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
  });

  it("retains the consumed generation when the settlement rescan finds an unreadable candidate", async () => {
    const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
    await fs.mkdir(peerAgentDir, { recursive: true });
    const originalStore = createExpiredOauthStore({ profileId, provider });
    saveAuthProfileStore(originalStore, peerAgentDir);
    saveAuthProfileStore(originalStore, mainAgentDir);

    const { promise: started, resolve: markStarted } = createDeferredCore();
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      markStarted();
      await finishRefreshGate;
      return {
        type: "oauth",
        provider,
        access: "preserved-rotation-access",
        refresh: "preserved-rotation-refresh",
        expires: Date.now() + 60 * 60 * 1000,
      } as never;
    });

    const resolving = resolveFrom(peerAgentDir);
    await started;
    const unreadableAgentDir = path.join(tempRoot, "agents", "peer-z", "agent");
    await fs.mkdir(unreadableAgentDir, { recursive: true });
    await fs.writeFile(resolveAuthProfileDatabasePath(unreadableAgentDir), "not a sqlite database");
    finishRefresh();

    await expect(resolving).rejects.toThrow("Failed to fence every historical OAuth refresh peer");
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
    for (const agentDir of [mainAgentDir, peerAgentDir]) {
      const terminal = read(agentDir);
      expect(terminal?.type === "oauth" && isOAuthRefreshFence(terminal)).toBe(true);
      expect(terminal?.type === "oauth" && isPendingOAuthRefreshFence(terminal)).toBe(false);
      expect(terminal).not.toMatchObject({
        access: "preserved-rotation-access",
        refresh: "preserved-rotation-refresh",
      });
    }

    closeOpenClawAgentDatabasesForTest(tempRoot);
    await fs.rm(resolveAuthProfileDatabasePath(unreadableAgentDir), { force: true });
    writePersistedAuthProfileStoreRaw(originalStore, unreadableAgentDir);

    await expect(resolveFrom(mainAgentDir)).resolves.toBeNull();
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
    const terminalLatePeer = read(unreadableAgentDir);
    expect(terminalLatePeer?.type === "oauth" && isOAuthRefreshFence(terminalLatePeer)).toBe(true);
    expect(terminalLatePeer?.type === "oauth" && isPendingOAuthRefreshFence(terminalLatePeer)).toBe(
      false,
    );
  });

  it("lets a completed re-login replace the owner while retiring consumed peers", async () => {
    const peers = await Promise.all(
      Array.from({ length: 2 }, async (_, index) => {
        const agentDir = path.join(tempRoot, "agents", `peer-${index}`, "agent");
        await fs.mkdir(agentDir, { recursive: true });
        saveAuthProfileStore(
          createExpiredOauthStore({ profileId, provider, accountId: "acct-a" }),
          agentDir,
        );
        return agentDir;
      }),
    );
    saveAuthProfileStore(
      createExpiredOauthStore({ profileId, provider, accountId: "acct-a" }),
      mainAgentDir,
    );

    const { promise: started, resolve: markStarted } = createDeferredCore();
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      markStarted();
      await finishRefreshGate;
      return {
        type: "oauth",
        provider,
        access: "stale-rotation-access",
        refresh: "stale-rotation-refresh",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "acct-a",
      } as never;
    });

    const resolving = resolveFrom(peers[0]);
    await started;
    await persistAuthProfileBatch({
      agentDir: mainAgentDir,
      profiles: [
        {
          profileId,
          credential: {
            type: "oauth",
            provider,
            access: "relogin-access",
            refresh: "relogin-refresh",
            expires: Date.now() + 60 * 60 * 1000,
            accountId: "acct-a",
          },
        },
      ],
      resetFailureState: true,
      allowOAuthGenerationReplacement: true,
    });
    expect(read(mainAgentDir)).toMatchObject({
      access: "relogin-access",
      refresh: "relogin-refresh",
    });
    finishRefresh();

    await expect(resolving).resolves.toEqual(expect.objectContaining({ apiKey: "relogin-access" }));
    expect(read(mainAgentDir)).toMatchObject({
      access: "relogin-access",
      refresh: "relogin-refresh",
    });
    for (const agentDir of peers) {
      expect(read(agentDir)).toBeUndefined();
    }
  });

  it("rolls back the owner and fenced peers when a candidate is unreadable", async () => {
    const peerAgentDir = path.join(tempRoot, "agents", "peer-a", "agent");
    const unreadableAgentDir = path.join(tempRoot, "agents", "peer-z", "agent");
    await fs.mkdir(peerAgentDir, { recursive: true });
    await fs.mkdir(unreadableAgentDir, { recursive: true });
    const original = createExpiredOauthStore({ profileId, provider });
    saveAuthProfileStore(original, peerAgentDir);
    saveAuthProfileStore(original, mainAgentDir);
    await fs.writeFile(
      path.join(unreadableAgentDir, "openclaw-agent.sqlite"),
      "not a sqlite database",
    );
    await expect(resolveFrom(peerAgentDir)).rejects.toThrow();
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expect(read(mainAgentDir)).toEqual(original.profiles[profileId]);
    expect(read(peerAgentDir)).toEqual(original.profiles[profileId]);
  });
});

describe("OAuth external owner boundaries", () => {
  it("refuses native refresh when durable metadata assigns the owner to an external CLI", async () => {
    const credential = createExpiredOauthStore({
      profileId: MINIMAX_CLI_PROFILE_ID,
      provider: "minimax-portal",
      authFlow: "external-cli",
    });
    saveAuthProfileStore(credential, mainAgentDir);

    await expect(
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(mainAgentDir),
        profileId: MINIMAX_CLI_PROFILE_ID,
        agentDir: mainAgentDir,
      }),
    ).resolves.toBeNull();
    expect(refreshProviderOAuthCredentialWithPluginMock).not.toHaveBeenCalled();
    expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
      credential.profiles[MINIMAX_CLI_PROFILE_ID],
    );
  });

  it("lets native device-code login reclaim the reserved MiniMax CLI profile id", async () => {
    const credential = createExpiredOauthStore({
      profileId: MINIMAX_CLI_PROFILE_ID,
      provider: "minimax-portal",
      authFlow: "external-cli",
    });
    saveAuthProfileStore(credential, mainAgentDir);
    const nativeCredential = createExpiredOauthStore({
      profileId: MINIMAX_CLI_PROFILE_ID,
      provider: "minimax-portal",
      authFlow: "device-code",
    }).profiles[MINIMAX_CLI_PROFILE_ID];
    if (nativeCredential?.type !== "oauth") {
      throw new Error("expected native MiniMax OAuth credential");
    }
    await persistAuthProfileBatch({
      agentDir: mainAgentDir,
      profiles: [{ profileId: MINIMAX_CLI_PROFILE_ID, credential: nativeCredential }],
      resetFailureState: true,
      allowOAuthGenerationReplacement: true,
    });
    expect(loadPersistedAuthProfileStore(mainAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
      nativeCredential,
    );
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue({
      type: "oauth",
      provider: "minimax-portal",
      access: "native-refreshed-access",
      refresh: "native-refreshed-refresh",
      expires: Date.now() + 60_000,
    });

    await expect(
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(mainAgentDir),
        profileId: MINIMAX_CLI_PROFILE_ID,
        agentDir: mainAgentDir,
      }),
    ).resolves.toEqual(expect.objectContaining({ apiKey: "native-refreshed-access" }));
    expect(refreshProviderOAuthCredentialWithPluginMock).toHaveBeenCalledOnce();
    expect(
      loadPersistedAuthProfileStore(mainAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID],
    ).toMatchObject({
      access: "native-refreshed-access",
      refresh: "native-refreshed-refresh",
    });
  });

  it("refuses to claim a generation still owned by a persisted external CLI profile", async () => {
    const peerAgentDir = path.join(tempRoot, "agents", "external-peer", "agent");
    await fs.mkdir(peerAgentDir, { recursive: true });
    const credential = createExpiredOauthStore({
      profileId: MINIMAX_CLI_PROFILE_ID,
      provider: "minimax-portal",
      authFlow: "external-cli",
    }).profiles[MINIMAX_CLI_PROFILE_ID];
    if (credential?.type !== "oauth") {
      throw new Error("expected external OAuth credential");
    }
    saveAuthProfileStore(
      {
        version: AUTH_STORE_VERSION,
        profiles: { [MINIMAX_CLI_PROFILE_ID]: credential },
      },
      peerAgentDir,
    );

    await expect(
      fenceOAuthRefreshPeers({
        cfg: {},
        ownerDatabasePath: resolveAuthProfileDatabasePath(mainAgentDir),
        profileId: MINIMAX_CLI_PROFILE_ID,
        generation: credential,
        fence: createOAuthRefreshFence({
          profileId: MINIMAX_CLI_PROFILE_ID,
          credential,
        }),
      }),
    ).rejects.toThrow("still owned by an external credential source");
    expect(loadPersistedAuthProfileStore(peerAgentDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
      credential,
    );
  });
});
