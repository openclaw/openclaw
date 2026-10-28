import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AuthStorage as PublicAuthStorage,
  ModelRegistry as PublicModelRegistry,
} from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as providerRuntime from "../../plugins/provider-runtime.runtime.js";
import * as sdkDeprecation from "../../plugins/sdk-deprecation.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential as createCredential,
} from "../auth-profiles/credential-fixtures.test-support.js";
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
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../auth-profiles/runtime-snapshots.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../auth-profiles/sqlite.js";
import * as authProfileStoreRuntime from "../auth-profiles/store-runtime.js";
import * as authProfileStoreUpdate from "../auth-profiles/store-update.js";
import type { AuthProfileStore, OAuthCredential } from "../auth-profiles/types.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage, OAuthProviderConfiguredUnavailableError } from "./auth-storage.js";
import {
  stored as readProfile,
  serializedBackend,
  withAgent,
  profileStore,
  oauthProvider,
  observeAuthTransactions,
  createSqliteAuthRefreshFixture,
} from "./auth-storage.test-support.js";

const providerOAuthMocks = {
  login: vi.fn<typeof providerRuntime.loginProviderOAuthWithPlugin>(),
  resolveCredential: vi.fn<typeof providerRuntime.resolveProviderOAuthCredentialWithPlugin>(),
};

const { ensureAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } =
  authProfileStoreRuntime;

function providerBCredential(overrides: Partial<OAuthCredential> = {}) {
  return createCredential({ provider: "provider-b", accountId: "acct-b", ...overrides });
}

function saveCredential(agentDir: string, profileId: string, credential: OAuthCredential) {
  saveAuthProfileStore(profileStore(credential, profileId), agentDir, {
    filterExternalAuthProfiles: false,
  });
}

function registerRefresh(storage: AuthStorage, providerId: string, credential: OAuthCredential) {
  const refresh = vi.fn(async () => credential);
  getAuthStorageOAuthProviderRegistry(storage).register(oauthProvider(providerId, refresh));
  return refresh;
}

function expectPublished(
  storage: AuthStorage,
  agentDir: string,
  providerId: string,
  credential: OAuthCredential | undefined,
) {
  expect(storage.get(providerId)).toEqual(credential);
  expect(readProfile(agentDir, `${providerId}:default`)).toEqual(credential);
}

function changeCredential(
  storage: AuthStorage,
  providerId: string,
  change: string,
  replacement: OAuthCredential,
) {
  if (change === "logout") {
    storage.logout(providerId);
  } else if (change === "replace") {
    storage.set(providerId, replacement);
  } else if (change === "unrelated") {
    storage.set("other", { type: "api_key", key: "synthetic-other-new" });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  clearAuthProfileMigrationDiagnostics();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawStateDatabaseForTest();
});

describe("AuthStorage OAuth refresh ownership", () => {
  it("refreshes local OAuth credentials while the shared owner requires migration", () =>
    withAgent(async (agentDir, state) => {
      const providerId = "test-oauth";
      const sharedStore = { version: 1, profiles: {} };
      await state.writeJson("agents/main/agent/auth-profiles.json", {
        version: 1,
        profiles: {
          "anthropic:default": createApiKeyCredential("anthropic", "synthetic-legacy-key"),
        },
      });
      writePersistedAuthProfileStoreRaw(sharedStore);
      writePersistedAuthProfileStoreRaw(
        profileStore(createCredential({ provider: providerId, expires: 1 })),
        agentDir,
      );
      const storage = AuthStorage.forAgent(agentDir, {});
      const refreshed = createCredential({ provider: providerId });
      registerRefresh(storage, providerId, refreshed);
      const fallback = vi.fn(() => "synthetic-fallback-key");
      storage.setFallbackResolver(fallback);

      await expect(storage.getApiKey(providerId)).resolves.toBe(refreshed.access);
      expectPublished(storage, agentDir, providerId, refreshed);
      await expect(storage.getApiKey("anthropic")).rejects.toMatchObject({
        code: "AUTH_PROFILE_MIGRATION_REQUIRED",
        affectedProviders: ["anthropic"],
      });
      expect(fallback).not.toHaveBeenCalled();

      storage.set("litellm", { type: "api_key", key: "synthetic-local-key" });
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["litellm:default"]).toEqual(
        createApiKeyCredential("litellm", "synthetic-local-key"),
      );
      expect(readPersistedAuthProfileStoreRaw()).toEqual(sharedStore);
    }, "worker"));

  it.each(["worker", "main"])(
    "blocks credential writes and OAuth refresh when the %s destination requires migration",
    (agentId) =>
      withAgent(async (agentDir, state) => {
        writePersistedAuthProfileStoreRaw(
          profileStore(createCredential({ provider: "test-oauth", expires: 1 })),
          agentDir,
        );
        const storage = AuthStorage.forAgent(agentDir, {});
        const refreshToken = registerRefresh(
          storage,
          "test-oauth",
          createCredential({ provider: "test-oauth" }),
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
        expect(() =>
          storage.set("litellm", { type: "api_key", key: "synthetic-local-key" }),
        ).toThrow("requires legacy credential migration");
        await expect(storage.getApiKey("test-oauth")).rejects.toMatchObject({
          code: "AUTH_PROFILE_MIGRATION_REQUIRED",
        });
        expect(refreshToken).not.toHaveBeenCalled();
        expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(migrationStore);
      }, agentId),
  );

  describe.each(["manager", "serialized"])("%s provider ownership", (backendKind) => {
    it.each(["pending", "compare-and-swap", "observer"])("rejects changes at %s", (phase) =>
      withAgent(async (agentDir) => {
        const profileId = "openai:default";
        const attempted = createCredential({ expires: 1, accountId: "acct-a" });
        const foreign = providerBCredential(phase === "pending" ? { expires: 1 } : {});
        const foreignFence = createOAuthRefreshFence({ profileId, credential: foreign });
        const initial =
          phase === "compare-and-swap"
            ? attempted
            : phase === "pending"
              ? foreignFence
              : createOAuthRefreshFence({ profileId, credential: attempted });
        const refresh = vi.fn(async () => (phase === "observer" ? null : foreign));
        const resolve = vi.fn(async (credential: OAuthCredential) => credential.access);
        let reads = 0;
        const canRefresh = async (replace: (credential: OAuthCredential) => void) => {
          if (phase === "compare-and-swap") {
            replace(foreign);
          }
          return true;
        };
        if (backendKind === "manager") {
          const replace = (credential: OAuthCredential) =>
            saveCredential(agentDir, profileId, credential);
          replace(initial);
          mockOAuthProviderOperations({
            buildApiKey: async (_provider, credential) => resolve(credential),
            refreshCredential: refresh,
            canRefreshCredential: () => canRefresh(replace),
          });
          if (phase === "observer") {
            const load = authProfileStoreRuntime.loadAuthProfileStoreWithoutExternalProfilesAsync;
            vi.spyOn(
              authProfileStoreRuntime,
              "loadAuthProfileStoreWithoutExternalProfilesAsync",
            ).mockImplementation(async (...args) => {
              const store = await load(...args);
              const credential = store.profiles[profileId];
              if (
                credential?.type === "oauth" &&
                credential.provider === "openai" &&
                ++reads === 2
              ) {
                replace(foreignFence);
              }
              return store;
            });
          }
          await expect(
            createOAuthManager().resolveOAuthAccess({
              agentDir,
              credential: attempted,
              profileId,
              store:
                phase === "compare-and-swap"
                  ? ensureAuthProfileStoreWithoutExternalProfiles(agentDir)
                  : profileStore(attempted, profileId),
            }),
          ).resolves.toBeNull();
          if (phase === "compare-and-swap") {
            expect(readProfile(agentDir, profileId)).toEqual(foreign);
          }
        } else {
          const { backend, set } = serializedBackend(
            initial,
            {
              after: () => {
                if (++reads === 1 && phase === "observer") {
                  set(foreignFence);
                }
              },
            },
            profileId,
          );
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
              canRefresh: () => canRefresh(set),
              refresh: async () => {
                const credential = await refresh();
                return credential ? { apiKey: credential.access, credential } : null;
              },
              resolve: async (credential) => ({ apiKey: await resolve(credential), credential }),
              commit: () => {},
            }),
          ).resolves.toBeNull();
        }
        expect(resolve).not.toHaveBeenCalled();
        if (backendKind === "serialized" || phase !== "observer") {
          expect(refresh).not.toHaveBeenCalled();
        }
      }),
    );
  });
  it("hides custom-backend refresh claims and shares their settled credential with peers", async () => {
    const providerId = "test-oauth";
    const { backend, read } = serializedBackend(
      createCredential({ provider: providerId, expires: 1, accountId: "acct-123" }),
    );
    const started = createDeferredCore();
    const refresh = createDeferredCore<{ access: string; refresh: string; expires: number }>();
    const refreshToken = vi.fn(() => {
      started.resolve();
      return refresh.promise;
    });
    const provider = oauthProvider(providerId, refreshToken);
    const storage = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(storage).register(provider);

    const first = storage.getApiKey(providerId);
    await started.promise;

    expect(read()).toContain("openclaw-oauth-refresh-fence:v1:");
    expect(read()).not.toContain("access-token");
    expect(read()).not.toContain("refresh-token");
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
    const original = createCredential({ provider: providerId, expires: 1 });
    const { backend, read } = serializedBackend(original);
    const storage = AuthStorage.fromStorage(backend);

    await expect(storage.getApiKey(providerId)).resolves.toBeUndefined();
    expect(JSON.parse(read())[providerId]).toEqual(original);
  });

  it("does not replay a failed generation and allows environment fallback after restart", async () => {
    const providerId = "xai";
    const { backend, read } = serializedBackend(
      createCredential({ provider: providerId, expires: 1 }),
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
      expect(read()).not.toContain("access-token");
      expect(read()).not.toContain("refresh-token");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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
      withAgent(async (agentDir) => {
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
            const durable = readProfile(agentDir, profileId);
            if (
              durable?.type === "oauth" &&
              (phase === "claim"
                ? isPendingOAuthRefreshFence(durable)
                : durable.access === refreshed.access)
            ) {
              queued = true;
              queueMicrotask(() => {
                changeCredential(mutate, providerId, change, replacement);
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
        expectPublished(storage, agentDir, providerId, expected);
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
      }),
  );

  it.each(["unchanged", "logout", "replace"])(
    "preserves %s state when an observer publishes a settled credential",
    (change) =>
      withAgent(async (agentDir) => {
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
          const durable = readProfile(agentDir, profileId);
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
                changeCredential(peer, providerId, change, replacement);
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
        expectPublished(storage, agentDir, providerId, expected);
      }),
  );

  it.each([false, true])(
    "settles claim custody when publication read fails (replacement: %s)",
    (replace) =>
      withAgent(async (agentDir) => {
        const { storage, peer, providerId, profileId, replacement, refreshToken } =
          await createSqliteAuthRefreshFixture(agentDir);
        const readError = new Error("synthetic publication read failure");
        let queued = false;
        let failNextRead = false;
        observeAuthTransactions(
          () => {
            if (!queued) {
              const durable = readProfile(agentDir, profileId);
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
        const durable = readProfile(agentDir, profileId);
        if (replace) {
          expect(apiKey).toBe(replacement.access);
          expectPublished(storage, agentDir, providerId, replacement);
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
      }),
  );
});

describe("SQLite auth storage", () => {
  let tempDir: string;
  let agentDir: string;
  const unreadableStore = { version: 1, profiles: "invalid-profile-map" };
  const expiredOAuth = createCredential({
    provider: "test-oauth",
    access: "fake-expired-access",
    refresh: "fake-refresh",
    expires: 1,
  });
  const secretRuntimeError =
    "requires the active secrets runtime to materialize SecretRef credentials";
  const identity = { accountId: "fake-account-id", email: "fake-user@example.com" };

  function writeProfiles(profiles: unknown) {
    writePersistedAuthProfileStoreRaw({ version: 1, profiles }, agentDir);
  }

  const apiKey = (key: string) => ({ type: "api_key" as const, key });
  const stored = (profile = "test-oauth:default") =>
    loadPersistedAuthProfileStore(agentDir)?.profiles[profile];

  function runtimeProfiles(profiles: AuthProfileStore["profiles"]) {
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: { version: 1, profiles } }]);
  }

  function envRef(id: string) {
    return { source: "env" as const, provider: "default", id };
  }

  function loginCallbacks() {
    return { onAuth: vi.fn(), onPrompt: vi.fn(async () => "") };
  }

  function withWorkerState(prefix: string, action: (state: OpenClawTestState) => Promise<void>) {
    return withOpenClawTestState({ layout: "state-only", prefix }, async (state) => {
      agentDir = state.agentDir("worker");
      fs.mkdirSync(agentDir, { recursive: true });
      await action(state);
    });
  }

  function secretKey(keyRef: ReturnType<typeof envRef>, key?: string) {
    return { type: "api_key" as const, provider: "openai", keyRef, ...(key ? { key } : {}) };
  }

  async function withoutHostSql(action: () => Promise<void>) {
    const sql = observeHostDataSql();
    try {
      await action();
      expect(
        sql.queries.filter((query) => /\bauth_profile_(?:store|state)\b/i.test(query)),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
  }

  function freshOAuth(overrides: Partial<typeof expiredOAuth> = {}) {
    return {
      access: "fake-fresh-access",
      refresh: "fake-refresh",
      expires: Date.now() + 60_000,
      ...overrides,
    };
  }

  beforeEach(() => {
    tempDir = agentDir = fs.mkdtempSync(path.join(tmpdir(), "auth-sqlite-"));
    providerOAuthMocks.login.mockReset().mockResolvedValue({ status: "unowned" });
    vi.spyOn(providerRuntime, "loginProviderOAuthWithPlugin").mockImplementation(
      providerOAuthMocks.login,
    );
    providerOAuthMocks.resolveCredential.mockReset().mockResolvedValue({ status: "unowned" });
    vi.spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin").mockImplementation(
      providerOAuthMocks.resolveCredential,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes detached in-memory credentials without a legacy reload warning", () => {
    const warn = vi.spyOn(sdkDeprecation, "warnPluginSdkDeprecation").mockImplementation(() => {});
    const credential = apiKey("synthetic-initial-key");
    const storage = PublicAuthStorage.inMemory({ fixture: credential });
    credential.key = "synthetic-mutated-key";

    expect(storage.get("fixture")).toEqual(apiKey("synthetic-initial-key"));
    expect(warn).not.toHaveBeenCalled();

    storage.reload();
    expect(warn).toHaveBeenCalledWith({
      family: "auth-profile-sync-operations",
      method: "AuthStorage.reload",
      replacement: "AuthStorage.reloadAsync",
    });
    expect(storage.get("fixture")).toEqual(apiKey("synthetic-initial-key"));
  });

  it("merges async SDK writes and reloads committed peer changes without host SQLite", async () => {
    await withWorkerState("auth-async-sdk-", async () => {
      const left = await PublicAuthStorage.forAgentAsync(agentDir);
      const right = await PublicAuthStorage.forAgentAsync(agentDir);
      await withoutHostSql(async () => {
        await Promise.all([
          left.setAsync("openai", apiKey("synthetic-openai")),
          right.setAsync("anthropic", apiKey("synthetic-anthropic")),
        ]);
        await left.reloadAsync();
        expect(left.list().toSorted()).toEqual(["anthropic", "openai"]);
        await right.removeAsync("openai");
        await left.reloadAsync();
        expect(left.get("openai")).toBeUndefined();
        expect(await left.getApiKey("anthropic")).toBe("synthetic-anthropic");
      });
    });
  });

  it("dispatches callback-based login to the owning provider plugin", async () => {
    const storage = await AuthStorage.forAgentAsync(agentDir);
    const callbacks = loginCallbacks();
    providerOAuthMocks.login.mockResolvedValueOnce({
      status: "available",
      credentials: freshOAuth({ access: "fake-access" }),
    });

    await storage.login("plugin-oauth", callbacks);

    expect(providerOAuthMocks.login).toHaveBeenCalledWith({
      provider: "plugin-oauth",
      context: callbacks,
    });
    expect(stored("plugin-oauth:default")).toMatchObject({
      type: "oauth",
      provider: "plugin-oauth",
      access: "fake-access",
      refresh: "fake-refresh",
    });
  });

  it("returns a typed actionable error when an owned OAuth plugin is unavailable", async () => {
    const storage = AuthStorage.forAgent(agentDir);
    providerOAuthMocks.login.mockResolvedValueOnce({ status: "configured-unavailable" });

    const login = storage.login("plugin-oauth", loginCallbacks());
    await expect(login).rejects.toMatchObject({
      name: "OAuthProviderConfiguredUnavailableError",
      code: "OAUTH_PROVIDER_CONFIGURED_UNAVAILABLE",
      state: "configured-unavailable",
      providerId: "plugin-oauth",
    });
    await expect(login).rejects.toBeInstanceOf(OAuthProviderConfiguredUnavailableError);
  });

  it("never overwrites a store that becomes unreadable before a synchronous write", () => {
    const storage = AuthStorage.forAgent(agentDir);
    writePersistedAuthProfileStoreRaw(unreadableStore, agentDir);

    expect(() => storage.set("anthropic", apiKey("fake-new-key"))).toThrow("is unreadable");
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadableStore);
    expect(storage.has("anthropic")).toBe(false);
  });

  it("records unreadable canonical stores and blocks environment fallback", async () => {
    const storage = AuthStorage.forAgent(agentDir);
    writePersistedAuthProfileStoreRaw(unreadableStore, agentDir);
    await refreshAuthProfileFileState();
    vi.stubEnv("OPENAI_API_KEY", "fake-environment-key");
    storage.reload();

    await expect(storage.getApiKey("openai")).rejects.toThrow("is unreadable");
    expect(storage.drainErrors().some((error) => error.message.includes("is unreadable"))).toBe(
      true,
    );
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadableStore);
  });

  it("does not commit a refresh when a legacy source appears during the provider call", async () => {
    writeProfiles({
      "test-oauth:default": { ...expiredOAuth, access: "not-a-real", refresh: "not-a-real" },
    });
    const storage = AuthStorage.forAgent(agentDir);
    getAuthStorageOAuthProviderRegistry(storage).register(
      oauthProvider("test-oauth", async () => {
        fs.writeFileSync(path.join(agentDir, "auth.json"), '{"legacy":true}\n', "utf8");
        return freshOAuth({ access: "not-a-real", refresh: "not-a-real" });
      }),
    );

    // The store already owns this profile, so a retired file appearing mid-call is
    // leftover bytes: discarding a completed refresh over it would strand the agent
    // on an expired token. Doctor never overwrites a usable stored credential.
    await expect(storage.getApiKey("test-oauth")).resolves.toBe("not-a-real");
    expect(stored()).not.toMatchObject({ expires: 1 });
  });

  it("keeps stored OAuth identity fields through the published agent sessions SDK", async () => {
    const metadata = { ...identity, subscriptionType: "max", rateLimitTier: "default_max_20x" };
    writeProfiles({ "test-oauth:default": { ...expiredOAuth, ...metadata } });
    const storage = await PublicAuthStorage.forAgentAsync(agentDir);
    PublicModelRegistry.inMemory(storage).registerProvider("test-oauth", {
      oauth: oauthProvider("test-oauth", async () =>
        freshOAuth({ refresh: "fake-rotated-refresh" }),
      ),
    });

    await withoutHostSql(async () => {
      await expect(storage.getApiKey("test-oauth")).resolves.toBe("fake-fresh-access");
    });
    expect(stored()).toMatchObject({
      type: "oauth",
      provider: "test-oauth",
      access: "fake-fresh-access",
      refresh: "fake-rotated-refresh",
      ...metadata,
    });
    expect(storage.get("test-oauth")).toMatchObject(identity);
  });

  it("keeps AuthStorage.create(path) as a named SQLite-backed deprecation", () => {
    const legacyPath = path.join(agentDir, "auth.json");
    const storage = AuthStorage.create(legacyPath);
    storage.set("openai", apiKey("fake-openai-key"));

    expect(stored("openai:default")).toMatchObject({
      key: "fake-openai-key",
    });
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("fails closed instead of ignoring credentials at a deprecated custom path", () => {
    const customPath = path.join(agentDir, "plugin-credentials.json");
    fs.writeFileSync(customPath, '{"openai":{"key":"not-a-real"}}\n', "utf8");

    expect(() => AuthStorage.create(customPath)).toThrow(
      expect.objectContaining({ code: "AUTH_PROFILE_MIGRATION_REQUIRED" }),
    );
    expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
  });

  it("reads materialized SecretRefs without persisting their resolved value", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-ambient-key");
    const keyRef = envRef("OPENAI_API_KEY");
    writeProfiles({
      "openai:default": secretKey(keyRef),
      "openai:work": secretKey(envRef("OPENAI_WORK_KEY")),
      "xai:default": {
        type: "token",
        provider: "xai",
        tokenRef: envRef("XAI_TOKEN"),
      },
    });
    expect(() => AuthStorage.forAgent(agentDir)).toThrow(secretRuntimeError);
    runtimeProfiles({
      "openai:default": secretKey(keyRef, "fake-materialized-key"),
      "xai:default": {
        type: "token",
        provider: "xai",
        tokenRef: envRef("XAI_TOKEN"),
        token: "fake-materialized-token",
      },
    });

    const storage = AuthStorage.forAgent(agentDir);
    expect(await storage.getApiKey("openai")).toBe("fake-materialized-key");
    expect(await storage.getApiKey("xai")).toBe("fake-materialized-token");
    storage.set("anthropic", apiKey("fake-anthropic-key"));

    const persisted = readPersistedAuthProfileStoreRaw(agentDir) as {
      profiles: Record<string, { key?: string; keyRef?: unknown }>;
    };
    expect(persisted.profiles["openai:default"]).toMatchObject({ keyRef });
    expect(persisted.profiles["openai:default"]?.key).toBeUndefined();
    storage.remove("openai");
    expect(
      (readPersistedAuthProfileStoreRaw(agentDir) as { profiles: Record<string, unknown> })
        .profiles["openai:default"],
    ).toBeUndefined();
  });

  it.each([
    ["its persisted SecretRef changes", "QA_AUTH_REF_OLD", true],
    ["the current snapshot is unresolved", "QA_AUTH_REF", false],
  ] as const)("rejects stale secrets when %s", async (_name, refId, changePersistedRef) => {
    const originalRef = envRef(refId);
    writeProfiles({ "openai:default": secretKey(originalRef) });
    runtimeProfiles({ "openai:default": secretKey(originalRef, "not-a-real") });
    const storage = AuthStorage.forAgent(agentDir);
    if (changePersistedRef) {
      expect(await storage.getApiKey("openai")).toBe("not-a-real");
      writeProfiles({ "openai:default": secretKey(envRef("QA_AUTH_REF_NEW")) });
      clearRuntimeAuthProfileStoreSnapshots();
    } else {
      runtimeProfiles({ "openai:default": secretKey(originalRef) });
    }

    storage.reload();

    await expect(storage.getApiKey("openai")).rejects.toThrow(secretRuntimeError);
  });

  it("preserves state-only SQLite rows when adding credentials", () => {
    const state = {
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
      usageStats: { "openai:default": { cooldownUntil: 1_900_000_000_000 } },
    };
    writePersistedAuthProfileStateRaw({ version: 1, ...state }, agentDir);

    AuthStorage.forAgent(agentDir).set("anthropic", apiKey("not-a-real"));

    expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic" },
      },
      ...state,
    });
  });

  it("revalidates widened shared refusals on the next credential request without reload", async () => {
    await withWorkerState("auth-shared-refusal-", async (state) => {
      writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
      const profiles = {
        "anthropic:default": createApiKeyCredential("anthropic", "synthetic-legacy-key"),
      };
      await state.writeJson("agents/main/agent/auth-profiles.json", { version: 1, profiles });
      const storage = AuthStorage.forAgent(agentDir);
      storage.setFallbackResolver(() => "synthetic-fallback-key");
      await expect(storage.getApiKey("nvidia")).resolves.toBeDefined();
      await state.writeJson("agents/main/agent/auth-profiles.json", {
        version: 1,
        profiles: {
          ...profiles,
          "nvidia:default": createApiKeyCredential("nvidia", "synthetic-new-legacy-key"),
        },
      });
      expect(() => assertAuthProfileMigrationReady(undefined, undefined, "nvidia")).toThrow(
        "requires legacy credential migration",
      );
      await expect(storage.getApiKey("nvidia")).rejects.toMatchObject({
        code: "AUTH_PROFILE_MIGRATION_REQUIRED",
        affectedProviders: ["anthropic", "nvidia"],
      });
    });
  });

  it("fails closed when a legacy credential source appears after construction", async () => {
    const storage = AuthStorage.forAgent(agentDir);
    vi.stubEnv("OPENAI_API_KEY", "fake-environment-key");
    fs.writeFileSync(path.join(agentDir, "auth.json"), '{"openai":{"key":"fake-late"}}\n');
    await refreshAuthProfileFileState();

    await expect(storage.getApiKey("openai")).rejects.toThrow(
      "requires legacy credential migration",
    );
  });

  it("fails closed for an identityless SQLite peer until the owner commits its rotation", async () => {
    writeProfiles({ "test-oauth:default": expiredOAuth });
    const left = AuthStorage.forAgent(agentDir);
    const right = AuthStorage.forAgent(agentDir);
    const refreshEntered = createDeferredCore();
    const releaseRefresh = createDeferredCore();
    const refresh = vi.fn(async () => {
      refreshEntered.resolve();
      await releaseRefresh.promise;
      return freshOAuth();
    });
    const provider = oauthProvider("test-oauth", refresh);
    getAuthStorageOAuthProviderRegistry(left).register(provider);
    getAuthStorageOAuthProviderRegistry(right).register(provider);

    const ownerKey = left.getApiKey("test-oauth");
    try {
      await refreshEntered.promise;
      const peerSelected = createDeferredCore();
      const runUpdate = authProfileStoreUpdate.runAuthProfileStoreUpdate;
      vi.spyOn(authProfileStoreUpdate, "runAuthProfileStoreUpdate").mockImplementationOnce(
        (params) => {
          const selecting = runUpdate({
            ...params,
            update: (prepared, owner) => {
              const credential = prepared.store.profiles["test-oauth:default"];
              expect(credential?.type === "oauth" && isPendingOAuthRefreshFence(credential)).toBe(
                true,
              );
              return params.update(prepared, owner);
            },
          });
          void selecting.then(peerSelected.resolve, peerSelected.reject);
          return selecting;
        },
      );
      const peerKey = right.getApiKey("test-oauth");
      void peerKey.catch(peerSelected.reject);
      await peerSelected.promise;
      releaseRefresh.resolve();
      await expect(Promise.all([ownerKey, peerKey])).resolves.toEqual([
        "fake-fresh-access",
        undefined,
      ]);
    } finally {
      releaseRefresh.resolve();
    }
    expect(refresh).toHaveBeenCalledOnce();
    await expect(right.getApiKey("test-oauth")).resolves.toBe("fake-fresh-access");
  });

  it("falls back to environment auth when a stored token is expired", async () => {
    writeProfiles({
      "xai:default": {
        type: "token",
        provider: "xai",
        token: "fake-expired-token",
        expires: 1,
      },
    });
    vi.stubEnv("XAI_API_KEY", "fake-environment-key");

    await expect(AuthStorage.forAgent(agentDir).getApiKey("xai")).resolves.toBe(
      "fake-environment-key",
    );
  });
});
