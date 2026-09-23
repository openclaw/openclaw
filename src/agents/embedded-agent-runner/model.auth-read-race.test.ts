import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import * as candidateStores from "../auth-profiles/candidate-stores.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "../auth-profiles/constants.js";
import { createOAuthManager } from "../auth-profiles/oauth-manager.js";
import { readPendingOAuthRefreshClaimId } from "../auth-profiles/oauth-refresh-marker.js";
import * as oauthObservation from "../auth-profiles/oauth-refresh-observation.js";
import * as authPaths from "../auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  noteRuntimeAuthProfileStorePersistedMutation,
  getRuntimeAuthProfileStoreSnapshotCore,
  registerRuntimeAuthProfileStoreMutationListener,
  setRuntimeAuthProfileStoreSnapshot,
} from "../auth-profiles/runtime-snapshots.js";
import * as sqliteRead from "../auth-profiles/sqlite-read.js";
import {
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "../auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
} from "../auth-profiles/store-runtime.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  restoreAuthProfileStorePersistenceSnapshot,
} from "../auth-profiles/store.js";
import type {
  AuthProfileRowRead,
  AuthProfileStore,
  OAuthCredential,
} from "../auth-profiles/types.js";
import { resolveDynamicModelAuthProfile } from "./model.registry-resolution.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([
  "one rotation",
  "continued rotation",
  "pinned profile rotation",
  "cleanup failure",
  "admission refusal",
] as const)("resolves model auth across %s during its captured read", async (change) => {
  const root = tempDirs.make("openclaw-model-auth-race-");
  const agentDir = path.join(root, "agents/main/agent");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.spyOn(authPaths, "resolveSharedAuthStoreOwnershipAsync").mockResolvedValue({
    location: "legacy-main",
  });
  const events: string[] = [];
  const refusal = new Error("Auth source admission revoked");
  const cleanupFailure = new Error("Auth child failed to close");
  let reads = 0;
  vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockImplementation(() => ({
    assertCurrent: () => {},
    dispose: async () => {
      events.push("disposed");
      if (change === "cleanup failure") {
        throw cleanupFailure;
      }
    },
    read: async (): Promise<AuthProfileRowRead> => {
      events.push("read");
      reads += 1;
      if (change === "admission refusal") {
        throw refusal;
      }
      const profileId = reads === 1 ? "custom:retired" : "custom:current";
      if (reads === 1 || change === "continued rotation") {
        noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
          credentialsChanged: true,
          stateChanged: false,
          profileIds: [profileId],
        });
      }
      return {
        store: {
          status: "readable",
          raw: {
            version: 1,
            profiles: { [profileId]: { type: "api_key", provider: "custom", key: "fixture" } },
          },
        },
        state: { status: "missing", reason: "row" },
        cacheable: true,
      };
    },
  }));

  const resolution = resolveDynamicModelAuthProfile({
    provider: "custom",
    modelId: "fixture",
    agentDir,
    ...(change === "pinned profile rotation" ? { authProfileId: "custom:retired" } : {}),
  });
  if (change === "one rotation") {
    await expect(resolution).resolves.toEqual({
      authProfileId: "custom:current",
      authProfileMode: "api_key",
    });
  } else if (change === "continued rotation") {
    await expect(resolution).rejects.toThrow("Auth profile store changed during its runtime read");
  } else if (change === "pinned profile rotation") {
    await expect(resolution).rejects.toMatchObject({
      code: "selected_auth_profile_unavailable",
      profileId: "custom:retired",
    });
  } else if (change === "admission refusal") {
    await expect(resolution).rejects.toBe(refusal);
  } else {
    await expect(resolution).rejects.toMatchObject({
      errors: [expect.any(Error), cleanupFailure],
    });
  }
  expect(events).toEqual(
    change === "cleanup failure" || change === "admission refusal"
      ? ["read", "disposed"]
      : ["read", "disposed", "read", "disposed"],
  );
});

it.each([
  "local",
  "inherited",
  "peer",
  "caller timeout",
  "unrelated pin",
  "unrelated provider",
  "local account override",
  "cold local account override",
  "cold copied peer",
  "reconnected account",
  "reconnected primary with peer",
  "restored claim",
  "peer CAS replacement",
  "already fenced peer",
  "local removed",
  "cold local removed",
  "cold local removed before local read",
  "inherited to local",
  "cold inherited to local",
  "other local profile changes",
  "foreign local removed",
  "foreign shared generation",
  "foreign shared replacement",
  "foreign shared portable replacement",
] as const)("resolves model auth across one OAuth claim and settlement: %s", async (scope) => {
  const root = tempDirs.make("openclaw-model-auth-refresh-race-");
  const agentDir = path.join(root, "agents/main/agent");
  const localOverride =
    scope === "local account override" ||
    scope === "cold local account override" ||
    scope === "peer CAS replacement" ||
    scope === "other local profile changes";
  const localRemoved = [
    "local removed",
    "cold local removed",
    "cold local removed before local read",
  ].includes(scope);
  const localAdded = scope === "inherited to local" || scope === "cold inherited to local";
  const foreignLocalChange =
    scope === "foreign local removed" || scope === "foreign shared generation";
  const foreignSharedChange =
    scope === "foreign shared replacement" || scope === "foreign shared portable replacement";
  const cold = scope.startsWith("cold ");
  const startDuringInheritedRead = cold && scope !== "cold local removed before local read";
  const reconnectedPrimary =
    scope === "reconnected account" || scope === "reconnected primary with peer";
  const copiedPeer =
    scope === "peer" ||
    scope === "cold copied peer" ||
    scope === "reconnected primary with peer" ||
    scope === "peer CAS replacement" ||
    scope === "already fenced peer";
  const readAgentDir =
    scope === "inherited" ||
    scope === "peer" ||
    localOverride ||
    localRemoved ||
    localAdded ||
    foreignLocalChange ||
    foreignSharedChange ||
    cold ||
    scope === "reconnected primary with peer" ||
    scope === "already fenced peer"
      ? path.join(root, "agents/worker/agent")
      : agentDir;
  if (scope === "caller timeout") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
  vi.spyOn(authPaths, "resolveSharedAuthStoreOwnershipAsync").mockResolvedValue({
    location: "legacy-main",
  });
  const profileId = "custom:oauth";
  const credential: OAuthCredential = {
    type: "oauth",
    provider: "custom",
    access: "fixture-access-before",
    refresh: "fixture-refresh-before",
    expires: Date.now() + 600_000,
    accountId: "fixture-account",
  };
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      [profileId]: credential,
      "custom:other": { type: "api_key", provider: "custom", key: "fixture-key" },
      "other:key": { type: "api_key", provider: "other", key: "fixture-other-key" },
    },
  };
  if (copiedPeer) {
    saveAuthProfileStore(store, readAgentDir);
  }
  saveAuthProfileStore(store, agentDir);
  if (scope === "inherited" || localAdded) {
    saveAuthProfileStore({ version: 1, profiles: {} }, readAgentDir);
    if (cold) {
      clearRuntimeAuthProfileStoreSnapshots();
    } else {
      setRuntimeAuthProfileStoreSnapshot({ ...store, runtimeLocalProfileIds: [] }, readAgentDir);
    }
  } else if (copiedPeer) {
    expect(loadPersistedAuthProfileStore(readAgentDir)?.profiles[profileId]).toEqual(credential);
    clearRuntimeAuthProfileStoreSnapshots();
  } else if (localOverride || localRemoved || foreignLocalChange || foreignSharedChange) {
    const localStore = {
      version: 1,
      profiles: {
        [profileId]: {
          ...credential,
          access: "fixture-local-access",
          refresh: "fixture-local-refresh",
          accountId: "fixture-local-account",
          ...(scope === "foreign shared portable replacement" ? { copyToAgents: true } : {}),
        },
      },
    };
    saveAuthProfileStore(localStore, readAgentDir);
    setRuntimeAuthProfileStoreSnapshot(
      { ...localStore, runtimeLocalProfileIds: [profileId] },
      readAgentDir,
    );
    if (cold) {
      clearRuntimeAuthProfileStoreSnapshots();
    }
  }
  const refreshEntered = createDeferred();
  let externallyReplacedStore: AuthProfileStore | undefined;
  let externallyFencedStore: AuthProfileStore | undefined;
  if (scope === "already fenced peer") {
    const loadCandidate = candidateStores.loadCandidateAuthProfileStore;
    vi.spyOn(candidateStores, "loadCandidateAuthProfileStore").mockImplementation((candidate) => {
      if (
        candidate.databasePath === resolveAuthProfileDatabasePath(readAgentDir) &&
        !externallyFencedStore
      ) {
        const pending = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
        if (!pending || !readPendingOAuthRefreshClaimId(pending)) {
          throw new Error("Expected owner claim before peer discovery");
        }
        externallyFencedStore = { version: 1, profiles: { [profileId]: pending } };
        runAuthProfileWriteTransaction(readAgentDir, (database) => {
          writePersistedAuthProfileStoreRaw(externallyFencedStore, readAgentDir, database);
        });
      }
      return loadCandidate(candidate);
    });
  }
  if (scope === "peer CAS replacement") {
    const updateCandidate = candidateStores.updateCandidateAuthProfileStore;
    vi.spyOn(candidateStores, "updateCandidateAuthProfileStore").mockImplementation((params) => {
      if (
        params.candidate.databasePath === resolveAuthProfileDatabasePath(readAgentDir) &&
        !externallyReplacedStore
      ) {
        externallyReplacedStore = {
          version: 1,
          profiles: {
            [profileId]: {
              ...credential,
              access: "fixture-local-access",
              refresh: "fixture-local-refresh",
              accountId: "fixture-local-account",
            },
          },
        };
        // A foreign writer changes SQLite without publishing into this process's observation registry.
        runAuthProfileWriteTransaction(readAgentDir, (database) => {
          writePersistedAuthProfileStoreRaw(externallyReplacedStore, readAgentDir, database);
        });
        const result = updateCandidate(params);
        expect(result.changed).toBe(false);
        return result;
      }
      return updateCandidate(params);
    });
  }
  const releaseRefresh = createDeferred();
  const retryEntered = createDeferred();
  const observationEntered = createDeferred();
  const settled = createDeferred();
  let derivedSnapshotInvalidated = false;
  const stopObservingMutations = registerRuntimeAuthProfileStoreMutationListener(() => {
    if (scope === "inherited" && !getRuntimeAuthProfileStoreSnapshotCore(readAgentDir)) {
      derivedSnapshotInvalidated = true;
    }
  });
  const refreshCredential = vi.fn(async (current: OAuthCredential) => {
    refreshEntered.resolve();
    await releaseRefresh.promise;
    return {
      ...current,
      access: "fixture-access-after",
      refresh: "fixture-refresh-after",
      expires: Date.now() + 1_200_000,
    };
  });
  const manager = createOAuthManager({
    buildApiKey: async (_provider, current) => {
      settled.resolve();
      return current.access;
    },
    canRefreshCredential: async () => true,
    refreshCredential,
    readBootstrapCredential: () => null,
  });
  const captureSettlement = oauthObservation.captureOAuthRefreshSettlement;
  vi.spyOn(oauthObservation, "captureOAuthRefreshSettlement").mockImplementation((params) => {
    const wait = captureSettlement(params);
    return wait
      ? async () => {
          observationEntered.resolve();
          await wait();
        }
      : undefined;
  });
  let refresh: ReturnType<typeof manager.resolveOAuthAccess> | undefined;
  let foreignLocalChanged = false;
  vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockImplementation(
    ({ databasePath }) => ({
      assertCurrent: () => {},
      dispose: async () => {},
      read: async () => {
        if (
          foreignLocalChange &&
          !foreignLocalChanged &&
          databasePath === resolveAuthProfileDatabasePath(readAgentDir)
        ) {
          foreignLocalChanged = true;
          // Simulate a foreign commit; its real rows change without a process-local auth publication.
          runAuthProfileWriteTransaction(readAgentDir, (database) => {
            writePersistedAuthProfileStoreRaw(
              {
                version: 1,
                profiles:
                  scope === "foreign local removed"
                    ? {}
                    : { [profileId]: { ...credential, copyToAgents: true } },
              },
              readAgentDir,
              database,
            );
          });
        }
        if (foreignSharedChange && !refresh) {
          const replacement = loadPersistedAuthProfileStore(readAgentDir);
          if (!replacement) {
            throw new Error("Missing local fixture");
          }
          runAuthProfileWriteTransaction(agentDir, (database) => {
            writePersistedAuthProfileStoreRaw(replacement, agentDir, database);
          });
        }
        const captured = loadPersistedAuthProfileStore(path.dirname(databasePath)) ?? {
          version: 1,
          profiles: {},
        };
        if (
          !refresh &&
          (!startDuringInheritedRead || databasePath === resolveAuthProfileDatabasePath(agentDir))
        ) {
          const activeStore = foreignSharedChange
            ? loadPersistedAuthProfileStore(agentDir)!
            : store;
          const activeCredential = activeStore.profiles[profileId];
          if (activeCredential?.type !== "oauth") {
            throw new Error("Expected current OAuth credential");
          }
          refresh = manager.resolveOAuthAccess({
            store: activeStore,
            profileId,
            credential: activeCredential,
            agentDir,
            forceRefresh: true,
          });
          void refresh.catch(() => {});
          await refreshEntered.promise;
          if (foreignSharedChange) {
            const local = loadPersistedAuthProfileStore(readAgentDir)?.profiles[profileId];
            if (scope === "foreign shared replacement") {
              expect(readPendingOAuthRefreshClaimId(local)).toEqual(expect.any(String));
            } else {
              expect(local).toMatchObject({ copyToAgents: true, refresh: "fixture-local-refresh" });
            }
          }
          if (localRemoved) {
            saveAuthProfileStore({ version: 1, profiles: {} }, readAgentDir);
          } else if (localAdded) {
            saveAuthProfileStore(
              {
                version: 1,
                profiles: {
                  [profileId]: {
                    ...credential,
                    access: "fixture-local-access",
                    refresh: "fixture-local-refresh",
                    accountId: "fixture-local-account",
                  },
                },
              },
              readAgentDir,
            );
          } else if (scope === "other local profile changes") {
            const current = loadPersistedAuthProfileStore(readAgentDir);
            if (!current) {
              throw new Error("Expected independent local profile");
            }
            saveAuthProfileStore(
              {
                ...current,
                profiles: {
                  ...current.profiles,
                  "custom:unrelated": {
                    type: "api_key",
                    provider: "custom",
                    key: "fixture-unrelated-key",
                  },
                },
              },
              readAgentDir,
            );
          }
          if (scope === "peer CAS replacement") {
            if (!externallyReplacedStore) {
              throw new Error("Peer CAS replacement did not run");
            }
            setRuntimeAuthProfileStoreSnapshot(
              { ...externallyReplacedStore, runtimeLocalProfileIds: [profileId] },
              readAgentDir,
            );
          } else if (copiedPeer) {
            expect(
              readPendingOAuthRefreshClaimId(
                loadPersistedAuthProfileStore(readAgentDir)?.profiles[profileId],
              ),
            ).toEqual(expect.any(String));
            if (scope === "already fenced peer") {
              if (!externallyFencedStore) {
                throw new Error("Peer fence was not copied before discovery");
              }
              setRuntimeAuthProfileStoreSnapshot(
                { ...externallyFencedStore, runtimeLocalProfileIds: [] },
                readAgentDir,
              );
            }
          }
          if (scope === "inherited") {
            expect(derivedSnapshotInvalidated).toBe(true);
          }
          expect(
            captureSettlement({
              databasePaths: [path.join(root, "unrelated", "openclaw-agent.sqlite")],
              profileId,
              matchesProvider: () => true,
            }),
          ).toBeUndefined();
          if (scope === "caller timeout") {
            const timedOut = expect(refresh).rejects.toThrow("exceeded hard timeout");
            await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_CALL_TIMEOUT_MS);
            await timedOut;
          }
        } else if (refresh) {
          retryEntered.resolve();
          if (!localOverride && scope !== "reconnected account") {
            await settled.promise;
          }
        }
        return {
          store: { status: "readable", raw: captured },
          state: { status: "missing", reason: "row" },
          cacheable: true,
        };
      },
    }),
  );
  const resolution = resolveDynamicModelAuthProfile({
    provider: scope === "unrelated provider" ? "other" : "custom",
    modelId: "fixture",
    agentDir: readAgentDir,
    authProfileId:
      scope === "unrelated pin"
        ? "custom:other"
        : scope === "unrelated provider"
          ? undefined
          : profileId,
  });
  try {
    const waitedForRefresh = await Promise.race([
      retryEntered.promise.then(() => false),
      observationEntered.promise.then(() => true),
      resolution.then(() => {
        throw new Error("Resolution skipped the refresh barrier");
      }),
    ]);
    if (localOverride) {
      expect(waitedForRefresh).toBe(false);
    } else if (localRemoved || localAdded) {
      releaseRefresh.resolve();
    } else if (scope === "restored claim") {
      const observe = () =>
        captureSettlement({
          databasePaths: [resolveAuthProfileDatabasePath(agentDir)],
          profileId,
          matchesProvider: () => true,
        });
      const beforeReplacement = observe();
      if (!beforeReplacement) {
        throw new Error("Expected pending claim before replacement");
      }
      const retired = beforeReplacement();
      const baseline = captureAuthProfileStorePersistenceSnapshot(agentDir);
      const replacement = saveAuthProfileStoreIfPersistenceSnapshotMatches({
        snapshot: baseline,
        agentDir,
        store: {
          ...store,
          profiles: {
            ...store.profiles,
            [profileId]: {
              ...credential,
              access: "fixture-temporary-access",
              refresh: "fixture-temporary-refresh",
            },
          },
        },
      });
      expect(replacement.publishRuntimeSnapshots()).toBe(true);
      await retired;
      expect(observe()).toBeUndefined();
      restoreAuthProfileStorePersistenceSnapshot(baseline, replacement.owned, agentDir);
      const restored = observe();
      expect(restored).toEqual(expect.any(Function));
      releaseRefresh.resolve();
      await restored?.();
    } else if (reconnectedPrimary) {
      saveAuthProfileStore(
        {
          ...store,
          profiles: {
            ...store.profiles,
            [profileId]: {
              ...credential,
              access: "fixture-reconnected-access",
              refresh: "fixture-reconnected-refresh",
            },
          },
        },
        agentDir,
      );
      expect(
        captureSettlement({
          databasePaths: [resolveAuthProfileDatabasePath(agentDir)],
          profileId,
          matchesProvider: () => true,
        }),
      ).toBeUndefined();
      if (scope === "reconnected primary with peer") {
        expect(
          captureSettlement({
            databasePaths: [resolveAuthProfileDatabasePath(readAgentDir)],
            profileId,
            matchesProvider: () => true,
          }),
        ).toEqual(expect.any(Function));
        releaseRefresh.resolve();
      }
    } else {
      releaseRefresh.resolve();
    }
    if (scope === "unrelated pin" || scope === "unrelated provider" || scope === "restored claim") {
      await expect(resolution).rejects.toThrow(
        "Auth profile store changed during its runtime read",
      );
    } else {
      await expect(resolution).resolves.toEqual({
        authProfileId: profileId,
        authProfileMode: "oauth",
      });
    }
    expect(refreshCredential).toHaveBeenCalledOnce();
    if (localRemoved || scope === "foreign local removed") {
      expect(loadPersistedAuthProfileStore(readAgentDir)?.profiles[profileId]).toBeUndefined();
      expect(
        loadAuthProfileStoreWithoutExternalProfiles(readAgentDir).profiles[profileId],
      ).toMatchObject({
        access: "fixture-access-after",
        accountId: "fixture-account",
      });
    }
    if (localOverride || localAdded) {
      expect(
        loadAuthProfileStoreWithoutExternalProfiles(readAgentDir).profiles[profileId],
      ).toMatchObject({
        access: "fixture-local-access",
        accountId: "fixture-local-account",
      });
      releaseRefresh.resolve();
      await refresh;
    }
    if (reconnectedPrimary) {
      releaseRefresh.resolve();
      await refresh;
    }
    expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId]).toMatchObject(
      {
        access: reconnectedPrimary ? "fixture-reconnected-access" : "fixture-access-after",
        refresh: reconnectedPrimary ? "fixture-reconnected-refresh" : "fixture-refresh-after",
      },
    );
  } finally {
    releaseRefresh.resolve();
    await Promise.allSettled([resolution, refresh]);
    await settled.promise;
    stopObservingMutations();
    vi.useRealTimers();
    await cleanupSessionStateForTest({ stateDir: root });
  }
});
