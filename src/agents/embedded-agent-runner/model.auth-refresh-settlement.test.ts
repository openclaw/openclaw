import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOAuthManager } from "../auth-profiles/oauth-manager.js";
import { isPendingOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import * as oauthObservation from "../auth-profiles/oauth-refresh-observation.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import * as sqliteRead from "../auth-profiles/sqlite-read.js";
import {
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStateRaw,
  readPersistedSharedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "../auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import type {
  AuthProfileRowRead,
  AuthProfileStore,
  OAuthCredential,
} from "../auth-profiles/types.js";
import { resolveDynamicModelAuthProfile } from "./model.registry-resolution.js";

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.restoreAllMocks();
});

function credential(): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "synthetic-current-access",
    refresh: "synthetic-current-refresh",
    accountId: "synthetic-account",
    expires: Date.now() + 86_400_000,
  };
}

function persistedRows(store: unknown, state: unknown): AuthProfileRowRead {
  return {
    store: store ? { status: "readable", raw: store } : { status: "missing", reason: "row" },
    state: state ? { status: "readable", raw: state } : { status: "missing", reason: "row" },
    cacheable: false,
  };
}

it.each(["settled", "replaced", "removed", "failed"] as const)(
  "resolves model selection after one real OAuth claim and its %s settlement",
  async (outcome) => {
    await withOpenClawTestState({ label: "model-auth-settlement" }, async (state) => {
      const agentDir = state.agentDir("reader");
      const databasePath = resolveAuthProfileDatabasePath(agentDir);
      const profileId = "openai:selection";
      const original = credential();
      const initialStore: AuthProfileStore = {
        version: 1,
        profiles: { [profileId]: original },
      };
      saveAuthProfileStore(initialStore, agentDir);
      vi.spyOn(sqliteRead, "readSharedAuthProfileRows").mockImplementation(async () =>
        persistedRows(
          readPersistedSharedAuthProfileStoreRaw(state.env),
          readPersistedSharedAuthProfileStateRaw(state.env),
        ),
      );

      const providerEntered = createDeferredCore();
      const releaseProvider = createDeferredCore();
      const joiningRefresh = createDeferredCore();
      const readingPendingFence = createDeferredCore();
      const providerFailure = new Error("Synthetic provider refresh failed");
      const manager = createOAuthManager({
        canRefreshCredential: async () => true,
        readBootstrapCredential: () => null,
        buildApiKey: async (_provider, current) => current.access,
        refreshCredential: async () => {
          const persisted = loadPersistedAuthProfileStore(agentDir);
          const fenced = persisted?.profiles[profileId];
          expect(isPendingOAuthRefreshFence(fenced?.type === "oauth" ? fenced : undefined)).toBe(
            true,
          );
          providerEntered.resolve();
          await releaseProvider.promise;
          if (outcome === "failed") {
            throw providerFailure;
          }
          if (outcome === "removed" || outcome === "replaced") {
            saveAuthProfileStore(
              {
                version: 1,
                profiles:
                  outcome === "removed"
                    ? {}
                    : {
                        [profileId]: {
                          type: "api_key",
                          provider: "openai",
                          key: "synthetic-replacement-key",
                        },
                      },
              },
              agentDir,
            );
          }
          return {
            ...original,
            access: "synthetic-settled-access",
            refresh: "synthetic-settled-refresh",
            expires: Date.now() + 2 * 86_400_000,
          };
        },
      });
      const captureSettlement = oauthObservation.captureOAuthRefreshSettlement;
      vi.spyOn(oauthObservation, "captureOAuthRefreshSettlement").mockImplementation((params) => {
        const wait = captureSettlement(params);
        return wait
          ? async () => {
              joiningRefresh.resolve();
              await wait();
            }
          : undefined;
      });
      let ownerReads = 0;
      let refresh: Promise<unknown> | undefined;
      vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockImplementation((owner) => ({
        assertCurrent: () => {},
        dispose: async () => {},
        read: async () => {
          const ownerAgentDir = path.dirname(owner.databasePath);
          const rows = persistedRows(
            readPersistedAuthProfileStoreRaw(ownerAgentDir),
            readPersistedAuthProfileStateRaw(ownerAgentDir),
          );
          if (owner.databasePath !== databasePath) {
            return rows;
          }
          ownerReads += 1;
          if (ownerReads === 1) {
            // This real claim revokes the first captured read. The provider stays
            // pending until selection joins it or wrongly begins its second read.
            refresh = manager
              .resolveOAuthAccess({
                store: initialStore,
                profileId,
                credential: original,
                agentDir,
                forceRefresh: true,
              })
              .then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
              );
            await Promise.race([providerEntered.promise, refresh]);
          } else {
            readingPendingFence.resolve();
            // Before the repair this read captures the pending fence and its
            // settlement invalidates the one remaining selection attempt.
            await refresh;
          }
          return rows;
        },
      }));
      const resolution = resolveDynamicModelAuthProfile({
        provider: "openai",
        modelId: "fixture",
        agentDir,
        ...(outcome === "failed" ? {} : { authProfileId: profileId }),
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([joiningRefresh.promise, readingPendingFence.promise, resolution]);
        releaseProvider.resolve();
        const result = await resolution;
        if (outcome === "removed") {
          expect(result).toMatchObject({
            error: { code: "selected_auth_profile_unavailable", profileId },
          });
        } else {
          expect(result).toEqual({
            value:
              outcome === "failed"
                ? {}
                : {
                    authProfileId: profileId,
                    authProfileMode: outcome === "replaced" ? "api_key" : "oauth",
                  },
          });
        }
        expect(ownerReads).toBe(2);
      } finally {
        releaseProvider.resolve();
        await refresh;
        await resolution;
      }
    });
  },
);
