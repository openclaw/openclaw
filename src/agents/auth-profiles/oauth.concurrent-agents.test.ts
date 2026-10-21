import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { AUTH_STORE_VERSION, MINIMAX_CLI_PROFILE_ID } from "./constants.js";
import {
  candidate,
  expired,
  expectTerminal,
  oauth,
  profileId,
  provider,
  read,
  useOAuthCoordinationFixture,
} from "./oauth-coordination.test-support.js";
import { createOAuthManager } from "./oauth-manager.js";
import { mockOAuthProviderOperations } from "./oauth-native-provider.test-support.js";
import { withOAuthProfileLock } from "./oauth-profile-lock.js";
import {
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "./oauth-refresh-marker.js";
import { failOAuthRefreshPeerClaims, fenceOAuthRefreshPeers } from "./oauth-refresh-peers.js";
import { storeWith } from "./oauth-test-utils.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { removeAuthProfilesAcrossOwnerStores } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath, writePersistedAuthProfileStoreRaw } from "./sqlite.js";
import {
  ensureAuthProfileStore,
  resolvePersistedAuthProfileOwnerAgentDirAsync,
  saveAuthProfileStore,
} from "./store-runtime.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "./store.js";
import type { OAuthCredential } from "./types.js";

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }, { id: "minimax-portal" }],
}));
const fx = useOAuthCoordinationFixture();

function cliCredential(authFlow = "external-cli"): OAuthCredential {
  return {
    type: "oauth",
    provider: "minimax-portal",
    authFlow,
    access: "cached-access-token",
    refresh: "refresh-token",
    expires: Date.now() - 60_000,
  };
}

function resolveManaged(agentDir: string, credential: OAuthCredential) {
  return createOAuthManager().resolveOAuthAccess({
    store: ensureAuthProfileStore(agentDir),
    profileId,
    credential,
    agentDir,
  });
}

describe("resolveApiKeyForProfile cross-agent refresh coordination (#26322)", () => {
  it("gives one copied refresh generation one durable main-store owner", async () => {
    const { createSqliteReadOnlyWorkerScope } =
      await import("../../infra/sqlite-readonly-worker.js");
    const readOnlyWorkers = createSqliteReadOnlyWorkerScope();
    const work = fx.work;
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    // Vitest can time out the observer before the accepted refresh finishes.
    fx.settle(async () => {
      finishRefresh();
      await work.drain();
      await readOnlyWorkers.close();
    });
    const runCase = async () => {
      const freshExpiry = Date.now() + 60 * 60 * 1000;
      const subAgents = await Promise.all(
        Array.from({ length: 4 }, async (_, i) => {
          const dir = path.join(fx.root, "agents", `sub-${i}`, "agent");
          await fs.mkdir(dir, { recursive: true });
          const local = expired({ accountId: "acct-a" });
          const credential = local.profiles[profileId];
          if (credential?.type === "oauth") {
            // Access and expiry can drift while the single-use refresh generation stays shared.
            credential.access = `local-drifted-access-${i}`;
            credential.expires = Date.now() - 1_000;
            if (i === 1) {
              delete credential.accountId;
            }
            if (i === 2) {
              credential.refresh = "independent-refresh-generation";
              credential.access = "independent-access";
              credential.expires = freshExpiry;
            } else if (i === 3) {
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
      const mainStore = expired({ accountId: "acct-a" });
      const mainCredential = mainStore.profiles[profileId];
      if (mainCredential?.type === "oauth") {
        mainCredential.access = "main-drifted-access";
      }
      saveAuthProfileStore(mainStore, fx.mainDir);

      const { promise: started, resolve: markStarted } = createDeferredCore();
      fx.refresh.mockImplementation(async () => {
        markStarted();
        await finishRefreshGate;
        return oauth("cross-agent-refreshed", {
          expires: freshExpiry,
          accountId: "acct-a",
        }) as never;
      });

      const first = fx.resolve(subAgents[0]);
      await Promise.race([started, first]);
      expect(
        resolvePersistedAuthProfileOwnerAgentDir({
          agentDir: subAgents[1],
          profileId,
        }),
      ).toBeUndefined();
      const [copiedOwner, independentOwner, portableOwner] = await Promise.all(
        subAgents
          .slice(1)
          .map((agentDir) =>
            work.track(() =>
              resolvePersistedAuthProfileOwnerAgentDirAsync({ agentDir, profileId }),
            ),
          ),
      );
      // A portable copy is not fenced, but its matching refresh generation still reads main.
      expect([copiedOwner, independentOwner, portableOwner]).toEqual([
        undefined,
        subAgents[2],
        undefined,
      ]);
      expect(fx.refresh).toHaveBeenCalledOnce();
      for (const agentDir of subAgents.slice(0, 2)) {
        const fenced = read(agentDir);
        expect(fenced?.type === "oauth" ? fenced.access : "").toMatch(
          /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:access:[a-f0-9]{64}$/,
        );
        expect(fenced?.type === "oauth" ? fenced.refresh : "").toMatch(
          /^openclaw-oauth-refresh-fence:v1:[a-f0-9]{32}:refresh:[a-f0-9]{64}$/,
        );
      }
      expect(read(subAgents[2])).toMatchObject({
        refresh: "independent-refresh-generation",
      });
      expect(read(subAgents[3])).toMatchObject({
        copyToAgents: true,
        refresh: "refresh-token",
      });

      finishRefresh();
      await expect(first).resolves.toMatchObject({
        apiKey: "cross-agent-refreshed-access",
        provider,
      });
      expect(fx.refresh).toHaveBeenCalledOnce();
      for (const [index, agentDir] of subAgents.slice(0, 2).entries()) {
        const persisted = loadPersistedAuthProfileStore(agentDir);
        expect(persisted?.profiles[profileId]).toBeUndefined();
        expect(persisted?.order?.openai).toEqual([profileId]);
        expect(persisted?.usageStats?.[profileId]?.lastUsed).toBe(index + 1);
      }
      expect(read(subAgents[2])).toMatchObject({
        access: "independent-access",
        refresh: "independent-refresh-generation",
      });
      expect(read(subAgents[3])).toMatchObject({
        access: "portable-access",
        copyToAgents: true,
      });

      await removeAuthProfilesAcrossOwnerStores({
        profileIds: [profileId],
        agentDir: fx.mainDir,
      });
      await expect(fx.resolve(subAgents[1])).resolves.toBeNull();
      clearRuntimeAuthProfileStoreSnapshots();
      await expect(fx.resolve(subAgents[1])).resolves.toBeNull();
      expect(fx.refresh).toHaveBeenCalledOnce();
      await expect(fx.resolve(subAgents[2])).resolves.toMatchObject({
        apiKey: "independent-access",
      });
      await expect(fx.resolve(subAgents[3])).resolves.toMatchObject({ apiKey: "portable-access" });
    };
    await readOnlyWorkers.run(() => work.track(runCase));
  }, 10_000);

  it("keeps pending observers read-only until the owner claims a late peer", async () => {
    const latePeerAgentDir = await fx.agentDirectory("late-peer");
    const originalStore = expired({ accountId: "acct-a" });
    const original = originalStore.profiles[profileId];
    if (original?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    saveAuthProfileStore(originalStore, fx.mainDir);

    const { promise: refreshStarted, resolve: markRefreshStarted } = createDeferredCore();
    const { promise: finishRefreshGate, resolve: finishRefresh } = createDeferredCore();
    fx.settle(async () => {
      finishRefresh();
      await fx.work.drain();
      vi.restoreAllMocks();
    });
    const refreshCredential = vi.fn(async () => {
      markRefreshStarted();
      await finishRefreshGate;
      return oauth("rotated-a", { accountId: "acct-a" });
    });
    mockOAuthProviderOperations({ refreshCredential });
    const owner = fx.work.track(() => resolveManaged(fx.mainDir, original));
    await refreshStarted;
    writePersistedAuthProfileStoreRaw(originalStore, latePeerAgentDir);

    const { promise: observerEntered, resolve: markObserverEntered } = createDeferredCore();
    // The coordination fixture resets modules; observe its current native namespace.
    const externalCliSync = await import("./external-cli-sync.js");
    vi.spyOn(externalCliSync, "readExternalCliBootstrapCredential").mockImplementation(() => {
      markObserverEntered();
      return null;
    });
    const observer = fx.work.track(() => resolveManaged(fx.mainDir, original));
    await observerEntered;
    await withOAuthProfileLock({ provider, profileId }, async () => {});

    expect(read(latePeerAgentDir)).toEqual(original);
    expect(refreshCredential).toHaveBeenCalledOnce();

    finishRefresh();
    await expect(owner).resolves.toMatchObject({ apiKey: "rotated-a-access" });
    await expect(observer).resolves.toMatchObject({ apiKey: "rotated-a-access" });
    expect(read(latePeerAgentDir)).toBeUndefined();
  });

  it("allows only one independent manager to own a late local refresh generation", async () => {
    const [firstAgentDir, secondAgentDir] = await Promise.all([
      fx.agentDirectory("first"),
      fx.agentDirectory("second"),
    ]);
    const originalStore = expired({ accountId: "acct-a" });
    const original = originalStore.profiles[profileId];
    if (original?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    saveAuthProfileStore(originalStore, firstAgentDir);

    const { promise: firstRefreshStarted, resolve: markFirstRefreshStarted } = createDeferredCore();
    const { promise: finishFirstRefreshGate, resolve: finishFirstRefresh } = createDeferredCore();
    fx.settle(async () => {
      finishFirstRefresh();
      await fx.work.drain();
      vi.restoreAllMocks();
    });
    const refreshCredential = vi.fn(async () => {
      if (refreshCredential.mock.calls.length === 1) {
        markFirstRefreshStarted();
        await finishFirstRefreshGate;
      }
      return oauth("rotated-a", { accountId: "acct-a" });
    });
    mockOAuthProviderOperations({ refreshCredential });
    const first = fx.work.track(() => resolveManaged(firstAgentDir, original));
    await firstRefreshStarted;
    const firstFence = read(firstAgentDir);
    expect(firstFence?.type === "oauth" && isPendingOAuthRefreshFence(firstFence)).toBe(true);

    writePersistedAuthProfileStoreRaw(originalStore, secondAgentDir);
    await expect(fx.work.track(() => resolveManaged(secondAgentDir, original))).rejects.toThrow(
      "historical OAuth refresh peer",
    );

    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(read(firstAgentDir)).toEqual(firstFence);
    expect(read(secondAgentDir)).toEqual(original);

    finishFirstRefresh();
    await expect(first).resolves.toMatchObject({ apiKey: "rotated-a-access" });
    expect(read(secondAgentDir)).toBeUndefined();
  });

  it("continues terminalizing peers after one candidate update fails", async () => {
    const original = expired().profiles[profileId];
    if (original?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    const fence = createOAuthRefreshFence({ profileId, credential: original });
    const unreadableAgentDir = path.join(fx.root, "agents", "peer-a", "agent");
    const readableAgentDir = path.join(fx.root, "agents", "peer-b", "agent");
    await fs.mkdir(unreadableAgentDir, { recursive: true });
    await fs.mkdir(readableAgentDir, { recursive: true });
    await fs.writeFile(resolveAuthProfileDatabasePath(unreadableAgentDir), "not a sqlite database");
    saveAuthProfileStore({ version: 1, profiles: { [profileId]: fence } }, readableAgentDir);
    const persistedFence = read(readableAgentDir);
    if (persistedFence?.type !== "oauth") {
      throw new Error("expected persisted OAuth fence");
    }

    await expect(
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
    ).rejects.toThrow();
    const terminal = read(readableAgentDir);
    expectTerminal(terminal);
  });

  it("rejects a same-generation login write while refresh owns the generation", async () => {
    const original = expired();
    saveAuthProfileStore(original, fx.mainDir);

    const { started, finishRefresh } = fx.blockRefresh(() => oauth("rotated"));

    const resolving = fx.resolve(fx.mainDir);
    await started;
    const originalCredential = original.profiles[profileId];
    if (originalCredential?.type !== "oauth") {
      throw new Error("expected original OAuth credential");
    }
    await expect(fx.reconnect(fx.mainDir, originalCredential)).rejects.toThrow(
      "Refused to restore fenced OAuth refresh generation",
    );
    const ownerFence = read(fx.mainDir);
    expect(ownerFence?.type === "oauth" && isOAuthRefreshFence(ownerFence)).toBe(true);

    finishRefresh();
    await expect(resolving).resolves.toMatchObject({ apiKey: "rotated-access" });
    expect(read(fx.mainDir)).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
  });

  it("retains the consumed generation when the settlement rescan finds an unreadable candidate", async () => {
    const peerAgentDir = await fx.agentDirectory("peer-a");
    const originalStore = expired();
    saveAuthProfileStore(originalStore, peerAgentDir);
    saveAuthProfileStore(originalStore, fx.mainDir);

    const { started, finishRefresh } = fx.blockRefresh(() => oauth("preserved-rotation"));

    const resolving = fx.resolve(peerAgentDir);
    await started;
    const unreadableAgentDir = await fx.agentDirectory("peer-z");
    await fs.writeFile(resolveAuthProfileDatabasePath(unreadableAgentDir), "not a sqlite database");
    finishRefresh();

    await expect(resolving).rejects.toThrow("Failed to fence every historical OAuth refresh peer");
    expect(fx.refresh).toHaveBeenCalledOnce();
    for (const agentDir of [fx.mainDir, peerAgentDir]) {
      const terminal = read(agentDir);
      expectTerminal(terminal);
      expect(terminal).not.toMatchObject({
        access: "preserved-rotation-access",
        refresh: "preserved-rotation-refresh",
      });
    }

    // Drain retained workers before resetting native fixture state and repairing the peer.
    await closeOpenClawAgentDatabasesAsync(fx.root);
    closeOpenClawAgentDatabasesForTest(fx.root);
    await fs.rm(resolveAuthProfileDatabasePath(unreadableAgentDir), { force: true });
    writePersistedAuthProfileStoreRaw(originalStore, unreadableAgentDir);

    await expect(fx.resolve(fx.mainDir)).resolves.toBeNull();
    expect(fx.refresh).toHaveBeenCalledOnce();
    const terminalLatePeer = read(unreadableAgentDir);
    expectTerminal(terminalLatePeer);
  });

  it("lets a completed re-login replace the owner while retiring consumed peers", async () => {
    const peers = await Promise.all(
      Array.from({ length: 2 }, async (_, index) => {
        const agentDir = path.join(fx.root, "agents", `peer-${index}`, "agent");
        await fs.mkdir(agentDir, { recursive: true });
        saveAuthProfileStore(expired({ accountId: "acct-a" }), agentDir);
        return agentDir;
      }),
    );
    saveAuthProfileStore(expired({ accountId: "acct-a" }), fx.mainDir);

    const { started, finishRefresh } = fx.blockRefresh(() =>
      oauth("stale-rotation", { accountId: "acct-a" }),
    );

    const resolving = fx.resolve(peers[0]);
    await started;
    await fx.reconnect(fx.mainDir, oauth("relogin", { accountId: "acct-a" }));
    expect(read(fx.mainDir)).toMatchObject({
      access: "relogin-access",
      refresh: "relogin-refresh",
    });
    finishRefresh();

    await expect(resolving).resolves.toMatchObject({ apiKey: "relogin-access" });
    expect(read(fx.mainDir)).toMatchObject({
      access: "relogin-access",
      refresh: "relogin-refresh",
    });
    for (const agentDir of peers) {
      expect(read(agentDir)).toBeUndefined();
    }
  });

  it("rolls back the owner and fenced peers when a candidate is unreadable", async () => {
    const peerAgentDir = path.join(fx.root, "agents", "peer-a", "agent");
    const unreadableAgentDir = path.join(fx.root, "agents", "peer-z", "agent");
    await fs.mkdir(peerAgentDir, { recursive: true });
    await fs.mkdir(unreadableAgentDir, { recursive: true });
    const original = expired();
    saveAuthProfileStore(original, peerAgentDir);
    saveAuthProfileStore(original, fx.mainDir);
    await fs.writeFile(
      path.join(unreadableAgentDir, "openclaw-agent.sqlite"),
      "not a sqlite database",
    );
    await expect(fx.resolve(peerAgentDir)).rejects.toThrow();
    expect(fx.refresh).not.toHaveBeenCalled();
    expect(read(fx.mainDir)).toEqual(original.profiles[profileId]);
    expect(read(peerAgentDir)).toEqual(original.profiles[profileId]);
  });
});

describe("OAuth external owner boundaries", () => {
  it("refuses native refresh when durable metadata assigns the owner to an external CLI", async () => {
    const credential = storeWith(MINIMAX_CLI_PROFILE_ID, cliCredential());
    saveAuthProfileStore(credential, fx.mainDir);

    await expect(fx.resolve(fx.mainDir, MINIMAX_CLI_PROFILE_ID)).resolves.toBeNull();
    expect(fx.refresh).not.toHaveBeenCalled();
    expect(loadPersistedAuthProfileStore(fx.mainDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
      credential.profiles[MINIMAX_CLI_PROFILE_ID],
    );
  });

  it("lets native device-code login reclaim the reserved MiniMax CLI profile id", async () => {
    const credential = storeWith(MINIMAX_CLI_PROFILE_ID, cliCredential());
    saveAuthProfileStore(credential, fx.mainDir);
    const nativeCredential = cliCredential("device-code");
    await fx.reconnect(fx.mainDir, nativeCredential, MINIMAX_CLI_PROFILE_ID);
    expect(loadPersistedAuthProfileStore(fx.mainDir)?.profiles[MINIMAX_CLI_PROFILE_ID]).toEqual(
      nativeCredential,
    );
    fx.refresh.mockResolvedValue({
      type: "oauth",
      provider: "minimax-portal",
      access: "native-refreshed-access",
      refresh: "native-refreshed-refresh",
      expires: Date.now() + 60_000,
    });

    await expect(fx.resolve(fx.mainDir, MINIMAX_CLI_PROFILE_ID)).resolves.toMatchObject({
      apiKey: "native-refreshed-access",
    });
    expect(fx.refresh).toHaveBeenCalledOnce();
    expect(
      loadPersistedAuthProfileStore(fx.mainDir)?.profiles[MINIMAX_CLI_PROFILE_ID],
    ).toMatchObject({
      access: "native-refreshed-access",
      refresh: "native-refreshed-refresh",
    });
  });

  it("refuses to claim a generation still owned by a persisted external CLI profile", async () => {
    const peerAgentDir = await fx.agentDirectory("external-peer");
    const credential = cliCredential();
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
        ownerDatabasePath: resolveAuthProfileDatabasePath(fx.mainDir),
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
