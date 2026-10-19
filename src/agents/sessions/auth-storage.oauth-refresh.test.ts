import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthProviderInterface } from "../../llm/utils/oauth/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOAuthRefreshCredential as createCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { refreshAuthProfileFileState } from "../auth-profiles/file-state.js";
import {
  assertAuthProfileMigrationReady,
  clearAuthProfileMigrationDiagnostics,
} from "../auth-profiles/legacy-source-diagnostic.js";
import { createOAuthManager } from "../auth-profiles/oauth-manager.js";
import { mockOAuthProviderOperations } from "../auth-profiles/oauth-native-provider.test-support.js";
import { refreshSerializedOAuthCredential } from "../auth-profiles/oauth-refresh-fence.js";
import {
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "../auth-profiles/oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles/runtime-snapshots.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../auth-profiles/sqlite.js";
import * as authProfileSqlite from "../auth-profiles/sqlite.js";
import * as authProfileStoreRuntime from "../auth-profiles/store-runtime.js";
import * as authProfileStoreUpdate from "../auth-profiles/store-update.js";
import type { AuthProfileStore, OAuthCredential } from "../auth-profiles/types.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage, type AuthStorageBackend } from "./auth-storage.js";

const { ensureAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } =
  authProfileStoreRuntime;

function profileStore(
  credential: OAuthCredential,
  profileId = `${credential.provider}:default`,
  extra: AuthProfileStore["profiles"] = {},
) {
  return { version: 1, profiles: { ...extra, [profileId]: credential } };
}

function oauthProvider(
  id: string,
  refreshToken: OAuthProviderInterface["refreshToken"],
): OAuthProviderInterface {
  return {
    id,
    name: "Test OAuth",
    async login() {
      throw new Error("not used");
    },
    refreshToken,
    getApiKey: (credential) => credential.access,
  };
}

function serializedBackend(
  initial: OAuthCredential,
  hooks: { before?: () => void; after?: () => void } = {},
  profileId = initial.provider,
) {
  let persisted = JSON.stringify({ [profileId]: initial });
  const set = (credential: OAuthCredential) => {
    persisted = JSON.stringify({ [profileId]: credential });
  };
  const backend: AuthStorageBackend = {
    withLock: (fn) => {
      hooks.before?.();
      try {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      } finally {
        hooks.after?.();
      }
    },
    async withLockAsync() {
      throw new Error("refresh must not use withLockAsync");
    },
  };
  return { backend, read: () => persisted, set };
}

function providerBCredential(overrides: Partial<OAuthCredential> = {}) {
  return createCredential({
    provider: "provider-b",
    access: "provider-b-access",
    refresh: "provider-b-refresh",
    expires: Date.now() + 600_000,
    accountId: "acct-b",
    ...overrides,
  });
}

function saveCredential(agentDir: string, profileId: string, credential: OAuthCredential) {
  saveAuthProfileStore(profileStore(credential, profileId), agentDir, {
    filterExternalAuthProfiles: false,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  clearAuthProfileMigrationDiagnostics();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawStateDatabaseForTest();
});

describe("AuthStorage OAuth refresh ownership", () => {
  it("refreshes local OAuth credentials while the shared owner requires migration", () =>
    withOpenClawTestState(
      { layout: "state-only", prefix: "auth-local-refresh-" },
      async (state) => {
        const agentDir = state.agentDir("worker");
        await fs.mkdir(agentDir, { recursive: true });
        const providerId = "test-oauth";
        const credential = createCredential({ provider: providerId, expires: 1 });
        const sharedStore = { version: 1, profiles: {} };
        await state.writeJson("agents/main/agent/auth-profiles.json", {
          version: 1,
          profiles: {
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "synthetic-legacy-key",
            },
          },
        });
        writePersistedAuthProfileStoreRaw(sharedStore);
        writePersistedAuthProfileStoreRaw(profileStore(credential), agentDir);
        const storage = AuthStorage.forAgent(agentDir, {});
        const refreshed = createCredential({
          provider: providerId,
          access: "synthetic-refreshed-access",
          refresh: "synthetic-refreshed-refresh",
        });
        const refreshToken = vi.fn(async () => refreshed);
        getAuthStorageOAuthProviderRegistry(storage).register(
          oauthProvider(providerId, refreshToken),
        );
        const fallback = vi.fn(() => "synthetic-fallback-key");
        storage.setFallbackResolver(fallback);

        await expect(storage.getApiKey(providerId)).resolves.toBe(refreshed.access);
        expect(refreshToken).toHaveBeenCalledOnce();
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[`${providerId}:default`]).toEqual(
          refreshed,
        );
        await expect(storage.getApiKey("anthropic")).rejects.toMatchObject({
          code: "AUTH_PROFILE_MIGRATION_REQUIRED",
          affectedProviders: ["anthropic"],
        });
        expect(fallback).not.toHaveBeenCalled();

        storage.set("litellm", { type: "api_key", key: "synthetic-local-key" });
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles["litellm:default"]).toEqual({
          type: "api_key",
          provider: "litellm",
          key: "synthetic-local-key",
        });
        expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedStore);
      },
    ));

  it.each(["worker", "main"])(
    "blocks credential writes and OAuth refresh when the %s destination requires migration",
    (agentId) =>
      withOpenClawTestState(
        { layout: "state-only", prefix: "auth-write-fence-" },
        async (state) => {
          const agentDir = state.agentDir(agentId);
          await fs.mkdir(agentDir, { recursive: true });
          const originalStore = profileStore(
            createCredential({ provider: "test-oauth", expires: 1 }),
          );
          writePersistedAuthProfileStoreRaw(originalStore, agentDir);
          const storage = AuthStorage.forAgent(agentDir, {});
          const refreshToken = vi.fn(async () => createCredential({ provider: "test-oauth" }));
          getAuthStorageOAuthProviderRegistry(storage).register(
            oauthProvider("test-oauth", refreshToken),
          );
          // A populated SQLite owner treats legacy files as leftover bytes. Once
          // emptied, its matching legacy credential must block further credential use.
          const migrationStore = { version: 1, profiles: {} };
          writePersistedAuthProfileStoreRaw(migrationStore, agentDir);
          await state.writeJson(
            `agents/${agentId}/agent/auth-profiles.json`,
            agentId === "worker"
              ? { metadata: {} }
              : profileStore(createCredential({ provider: "test-oauth" })),
          );
          await refreshAuthProfileFileState();
          expect(() => assertAuthProfileMigrationReady(agentDir)).toThrow(
            "requires legacy credential migration",
          );
          const write = vi.spyOn(authProfileStoreRuntime, "saveAuthProfileStoreWithPreparedOwner");
          expect(() =>
            storage.set("litellm", { type: "api_key", key: "synthetic-local-key" }),
          ).toThrow("requires legacy credential migration");
          await expect(storage.getApiKey("test-oauth")).rejects.toMatchObject({
            code: "AUTH_PROFILE_MIGRATION_REQUIRED",
          });
          expect(refreshToken).not.toHaveBeenCalled();
          expect(write).not.toHaveBeenCalled();
          expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(migrationStore);
        },
      ),
  );

  it.each(["pending", "compare-and-swap", "observer"])(
    "rejects a provider change during OAuth manager %s",
    async (phase) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: `oauth-manager-provider-${phase}-` },
        async (state) => {
          const agentDir = state.agentDir();
          await fs.mkdir(agentDir, { recursive: true });
          const profileId = "openai:oauth";
          const attempted = createCredential({ expires: 1, accountId: "acct-a" });
          const providerB = providerBCredential(phase === "pending" ? { expires: 1 } : {});
          const foreignFence = createOAuthRefreshFence({ profileId, credential: providerB });
          saveCredential(
            agentDir,
            profileId,
            phase === "compare-and-swap"
              ? attempted
              : phase === "pending"
                ? foreignFence
                : createOAuthRefreshFence({ profileId, credential: attempted }),
          );
          const buildApiKey = vi.fn(
            async (_provider, credential: OAuthCredential) => credential.access,
          );
          const refreshCredential = vi.fn(async () => (phase === "observer" ? null : providerB));
          mockOAuthProviderOperations({
            buildApiKey,
            refreshCredential,
            canRefreshCredential: async () => {
              if (phase === "compare-and-swap") {
                saveCredential(agentDir, profileId, providerB);
              }
              return true;
            },
          });
          const manager = createOAuthManager();

          if (phase === "pending") {
            const load = authProfileStoreRuntime.loadAuthProfileStoreWithoutExternalProfiles;
            let reads = 0;
            vi.spyOn(
              authProfileStoreRuntime,
              "loadAuthProfileStoreWithoutExternalProfiles",
            ).mockImplementation((...args) => {
              const store = load(...args);
              const credential = store.profiles[profileId];
              if (
                credential?.type === "oauth" &&
                credential.provider === "provider-b" &&
                isPendingOAuthRefreshFence(credential) &&
                ++reads > 1
              ) {
                throw new Error("provider-B fence must not be observed");
              }
              return store;
            });
          } else if (phase === "observer") {
            const load = authProfileStoreRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync;
            let ownReads = 0;
            let foreignReads = 0;
            vi.spyOn(
              authProfileStoreRuntime,
              "loadAuthProfileStoreWithoutExternalProfilesAsync",
            ).mockImplementation(async (...args) => {
              const store = await load(...args);
              const credential = store.profiles[profileId];
              if (credential?.type === "oauth" && credential.provider === "openai") {
                if (++ownReads === 2) {
                  saveCredential(agentDir, profileId, foreignFence);
                }
              } else if (
                credential?.type === "oauth" &&
                credential.provider === "provider-b" &&
                isPendingOAuthRefreshFence(credential) &&
                ++foreignReads > 1
              ) {
                throw new Error("provider-B fence observation continued");
              }
              return store;
            });
          }

          const store =
            phase === "compare-and-swap"
              ? ensureAuthProfileStoreWithoutExternalProfiles(agentDir)
              : profileStore(attempted, profileId);
          await expect(
            manager.resolveOAuthAccess({ agentDir, credential: attempted, store, profileId }),
          ).resolves.toBeNull();
          expect(buildApiKey).not.toHaveBeenCalled();
          if (phase !== "observer") {
            expect(refreshCredential).not.toHaveBeenCalled();
          }
          if (phase === "compare-and-swap") {
            expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(providerB);
          }
        },
      );
    },
  );
  it.each(["pending initial fence", "post-canRefresh replacement", "observer fence replacement"])(
    "rejects a serialized provider change from a %s",
    async (phase) => {
      const profileId = "openai:default";
      const foreign = createCredential({ provider: "provider-b", expires: 1 });
      const foreignFence = createOAuthRefreshFence({ profileId, credential: foreign });
      const initial =
        phase === "pending initial fence"
          ? foreignFence
          : phase === "observer fence replacement"
            ? createOAuthRefreshFence({ profileId, credential: createCredential({ expires: 1 }) })
            : createCredential({ expires: 1 });
      let calls = 0;
      const { backend, set } = serializedBackend(
        initial,
        {
          before: () => {
            calls += 1;
            if (
              (phase === "pending initial fence" && calls > 1) ||
              (phase === "observer fence replacement" && calls > 2)
            ) {
              throw new Error("provider-B fence must not be observed");
            }
          },
          after: () => {
            if (phase === "observer fence replacement" && calls === 1) {
              set(foreignFence);
            }
          },
        },
        profileId,
      );
      const refreshed = providerBCredential();
      const refresh = vi.fn(async () => ({ apiKey: refreshed.access, credential: refreshed }));
      const resolve = vi.fn(async (credential: OAuthCredential) => ({
        apiKey: credential.access,
        credential,
      }));
      await expect(
        refreshSerializedOAuthCredential({
          backend,
          provider: "openai",
          profileId,
          label: "test serialized provider ownership",
          timeoutMs: 1_000,
          parse: (current) => JSON.parse(current ?? "{}") as Record<string, OAuthCredential>,
          serialize: JSON.stringify,
          readCredential: (data) => data[profileId],
          writeCredential: (data, credential) => ({ ...data, [profileId]: credential }),
          canRefresh: async () => {
            if (phase === "post-canRefresh replacement") {
              set(createCredential({ provider: "provider-b", expires: Date.now() + 600_000 }));
            }
            return true;
          },
          refresh,
          resolve,
          commit: () => {},
        }),
      ).resolves.toBeNull();
      expect(refresh).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );
  it("runs provider I/O outside custom backend locks and fences peer retries", async () => {
    const providerId = "test-oauth";
    let lockDepth = 0;
    const { backend, read } = serializedBackend(
      createCredential({
        provider: providerId,
        access: "claimed-access",
        refresh: "claimed-refresh",
        expires: 1,
        accountId: "acct-123",
      }),
      {
        before: () => {
          expect(lockDepth).toBe(0);
          lockDepth += 1;
        },
        after: () => {
          lockDepth -= 1;
        },
      },
    );
    const started = createDeferredCore();
    const refresh = createDeferredCore<{ access: string; refresh: string; expires: number }>();
    const refreshToken = vi.fn(() => {
      expect(lockDepth).toBe(0);
      started.resolve();
      return refresh.promise;
    });
    const provider = oauthProvider(providerId, refreshToken);
    const storage = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(storage).register(provider);

    const first = storage.getApiKey(providerId);
    await started.promise;

    expect(read()).toContain("openclaw-oauth-refresh-fence:v1:");
    expect(read()).not.toContain("claimed-access");
    expect(read()).not.toContain("claimed-refresh");
    expect(storage.get(providerId)).toBeUndefined();
    expect(storage.has(providerId)).toBe(false);
    expect(storage.list()).not.toContain(providerId);
    expect(storage.getAll()).toEqual({});
    expect(storage.getAuthStatus(providerId)).toEqual({ configured: false });
    const peer = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(peer).register(provider);
    const peerResult = peer.getApiKey(providerId);
    expect(refreshToken).toHaveBeenCalledTimes(1);

    refresh.resolve({
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 600_000,
    });
    await expect(first).resolves.toBe("rotated-access");
    await expect(peerResult).resolves.toBe("rotated-access");
    expect(JSON.parse(read())).toMatchObject({
      [providerId]: {
        access: "rotated-access",
        refresh: "rotated-refresh",
        accountId: "acct-123",
      },
    });
  });

  it("preserves an expired credential when no refresh owner exists", async () => {
    const providerId = "unowned-oauth";
    const original = createCredential({
      provider: providerId,
      access: "unowned-access",
      refresh: "unowned-refresh",
      expires: 1,
    });
    const { backend, read } = serializedBackend(original);
    const storage = AuthStorage.fromStorage(backend);

    await expect(storage.getApiKey(providerId)).resolves.toBeUndefined();
    expect(JSON.parse(read())[providerId]).toEqual(original);
  });

  it("does not replay a failed generation and allows environment fallback after restart", async () => {
    const providerId = "xai";
    const { backend, read } = serializedBackend(
      createCredential({
        provider: providerId,
        access: "failed-access",
        refresh: "failed-refresh",
        expires: 1,
      }),
    );
    const refreshToken = vi.fn(async () => {
      throw new Error("simulated provider rejection");
    });
    const provider = oauthProvider(providerId, refreshToken);
    const first = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(first).register(provider);
    await expect(first.getApiKey(providerId)).resolves.toBeUndefined();

    vi.stubEnv("XAI_API_KEY", "environment-fallback");
    try {
      const restarted = AuthStorage.fromStorage(backend);
      getAuthStorageOAuthProviderRegistry(restarted).register(provider);
      await expect(restarted.getApiKey(providerId)).resolves.toBe("environment-fallback");
      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(read()).toContain("openclaw-oauth-refresh-fence:v1:");
      expect(read()).not.toContain("failed-access");
      expect(read()).not.toContain("failed-refresh");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function observeAuthTransactions(after: () => void, before?: () => void) {
  const runTransaction = authProfileSqlite.runAuthProfileWriteTransaction;
  vi.spyOn(authProfileSqlite, "runAuthProfileWriteTransaction").mockImplementation(
    (agentDir, operation, options) => {
      before?.();
      const result = runTransaction(agentDir, operation, options);
      after();
      return result;
    },
  );
  const runUpdate = authProfileStoreUpdate.runAuthProfileStoreUpdate;
  vi.spyOn(authProfileStoreUpdate, "runAuthProfileStoreUpdate").mockImplementation(
    async (params) => {
      before?.();
      await runUpdate(params);
      after();
    },
  );
}

function createPublicationCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return createCredential({
    provider: "test-oauth",
    access: "synthetic-access-a",
    refresh: "synthetic-refresh-a",
    expires: Date.now() + 600_000,
    accountId: "account-a",
    ...overrides,
  });
}

async function createSqliteAuthRefreshFixture(agentDir: string) {
  await fs.mkdir(agentDir, { recursive: true });
  const providerId = "test-oauth";
  const profileId = `${providerId}:default`;
  const initial = createPublicationCredential({ expires: 1 });
  const refreshed = createPublicationCredential({
    access: "synthetic-refreshed-a",
  });
  const replacement = createPublicationCredential({
    access: "synthetic-account-b",
    refresh: "synthetic-refresh-b",
    accountId: "account-b",
  });
  writePersistedAuthProfileStoreRaw(
    profileStore(initial, profileId, {
      "other:default": { type: "api_key", provider: "other", key: "synthetic-other-old" },
    }),
    agentDir,
  );
  const storage = AuthStorage.forAgent(agentDir, {});
  const peer = AuthStorage.forAgent(agentDir, {});
  const refreshToken = vi.fn(async () => refreshed);
  getAuthStorageOAuthProviderRegistry(storage).register(oauthProvider(providerId, refreshToken));
  return { storage, peer, providerId, profileId, refreshed, replacement, refreshToken };
}

describe("AuthStorage OAuth publication", () => {
  it.each([
    { phase: "claim", actor: "same", change: "logout" },
    { phase: "claim", actor: "peer", change: "replace" },
    { phase: "settlement", actor: "peer", change: "logout" },
    { phase: "settlement", actor: "same", change: "replace" },
    { phase: "claim", actor: "same", change: "unrelated" },
    { phase: "settlement", actor: "peer", change: "unrelated" },
  ])(
    "preserves $actor facade $change after durable $phase and before publication",
    ({ phase, actor, change }) =>
      withOpenClawTestState(
        { layout: "state-only", prefix: "auth-refresh-publication-" },
        async (state) => {
          const agentDir = state.agentDir();
          const { storage, peer, providerId, profileId, refreshed, replacement, refreshToken } =
            await createSqliteAuthRefreshFixture(agentDir);
          let otherWhenRefreshStarted = storage.get("other");
          refreshToken.mockImplementation(async () => {
            otherWhenRefreshStarted = storage.get("other");
            return refreshed;
          });
          const mutate = actor === "same" ? storage : peer;
          let queued = false;
          observeAuthTransactions(() => {
            if (!queued) {
              const durable = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
              if (
                durable?.type === "oauth" &&
                (phase === "claim"
                  ? isPendingOAuthRefreshFence(durable)
                  : durable.access === refreshed.access)
              ) {
                queued = true;
                queueMicrotask(() => {
                  if (change === "logout") {
                    mutate.logout(providerId);
                  } else if (change === "replace") {
                    mutate.set(providerId, replacement);
                  } else if (change === "unrelated") {
                    mutate.set("other", { type: "api_key", key: "synthetic-other-new" });
                  }
                });
              }
            }
          });

          const apiKey = await storage.getApiKey(providerId);
          expect(queued).toBe(true);
          const durable = loadPersistedAuthProfileStore(agentDir)?.profiles;
          const expected =
            change === "logout" ? undefined : change === "replace" ? replacement : refreshed;
          expect(apiKey).toBe(expected?.access);
          expect(storage.get(providerId)).toEqual(expected);
          expect(durable?.[profileId]).toEqual(expected);
          expect(refreshToken).toHaveBeenCalledTimes(
            phase === "claim" && (change === "logout" || change === "replace") ? 0 : 1,
          );
          const otherKey = change === "unrelated" ? "synthetic-other-new" : "synthetic-other-old";
          if (phase === "claim" && change === "unrelated") {
            expect(otherWhenRefreshStarted).toEqual({ type: "api_key", key: otherKey });
          }
          expect(storage.get("other")).toEqual({ type: "api_key", key: otherKey });
          expect(durable?.["other:default"]).toEqual({
            type: "api_key",
            provider: "other",
            key: otherKey,
          });
        },
      ),
  );

  it.each(["unchanged", "logout", "replace"])(
    "preserves %s state when an observer publishes a settled credential",
    (change) =>
      withOpenClawTestState(
        { layout: "state-only", prefix: "auth-refresh-observer-publication-" },
        async (state) => {
          const agentDir = state.agentDir();
          const { storage, peer, providerId, profileId, refreshed, replacement, refreshToken } =
            await createSqliteAuthRefreshFixture(agentDir);
          peer.set(providerId, createOAuthRefreshFence({ profileId, credential: refreshed }));
          storage.reload();
          let settlementQueued = false;
          let changeQueued = false;
          let settlingPeer = false;
          observeAuthTransactions(() => {
            if (settlingPeer) {
              return;
            }
            const durable = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
            if (durable?.type === "oauth") {
              if (!settlementQueued && isPendingOAuthRefreshFence(durable)) {
                settlementQueued = true;
                queueMicrotask(() => {
                  settlingPeer = true;
                  try {
                    peer.set(providerId, refreshed);
                  } finally {
                    settlingPeer = false;
                  }
                });
              } else if (!changeQueued && durable.access === refreshed.access) {
                changeQueued = true;
                queueMicrotask(() => {
                  if (change === "logout") {
                    peer.logout(providerId);
                  } else if (change === "replace") {
                    peer.set(providerId, replacement);
                  }
                });
              }
            }
          });

          const apiKey = await storage.getApiKey(providerId);
          expect(settlementQueued).toBe(true);
          expect(changeQueued).toBe(true);
          expect(refreshToken).not.toHaveBeenCalled();
          const expected =
            change === "logout" ? undefined : change === "replace" ? replacement : refreshed;
          expect(apiKey).toBe(expected?.access);
          expect(storage.get(providerId)).toEqual(expected);
          expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(expected);
        },
      ),
  );

  it.each([false, true])(
    "settles claim custody when publication read fails (replacement: %s)",
    (replace) =>
      withOpenClawTestState(
        { layout: "state-only", prefix: "auth-refresh-publication-read-failure-" },
        async (state) => {
          const agentDir = state.agentDir();
          const { storage, peer, providerId, profileId, replacement, refreshToken } =
            await createSqliteAuthRefreshFixture(agentDir);
          const readError = new Error("synthetic publication read failure");
          let queued = false;
          let failNextRead = false;
          observeAuthTransactions(
            () => {
              if (!queued) {
                const durable = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
                if (durable?.type === "oauth" && isPendingOAuthRefreshFence(durable)) {
                  queued = true;
                  queueMicrotask(() => {
                    if (replace) {
                      peer.set(providerId, replacement);
                    }
                    failNextRead = true;
                  });
                }
              }
            },
            () => {
              if (failNextRead) {
                failNextRead = false;
                throw readError;
              }
            },
          );

          const apiKey = await storage.getApiKey(providerId);
          expect(queued).toBe(true);
          expect(refreshToken).not.toHaveBeenCalled();
          expect(storage.drainErrors()).toContain(readError);
          const durable = loadPersistedAuthProfileStore(agentDir)?.profiles[profileId];
          if (replace) {
            expect(apiKey).toBe(replacement.access);
            expect(storage.get(providerId)).toEqual(replacement);
            expect(durable).toEqual(replacement);
          } else {
            expect(apiKey).toBeUndefined();
            expect(storage.get(providerId)).toBeUndefined();
            expect(durable?.type).toBe("oauth");
            if (durable?.type !== "oauth") {
              throw new Error("Expected the failed refresh to retain a terminal OAuth fence");
            }
            expect(isOAuthRefreshFence(durable)).toBe(true);
            expect(isPendingOAuthRefreshFence(durable)).toBe(false);
          }
        },
      ),
  );
});
