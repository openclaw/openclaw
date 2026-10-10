import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assertAuthProfileMigrationReady,
  clearAuthProfileMigrationDiagnostics,
} from "../auth-profiles/legacy-source-diagnostic.js";
import { createOAuthManager } from "../auth-profiles/oauth-manager.js";
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
import type { OAuthCredential } from "../auth-profiles/types.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage, type AuthStorageBackend } from "./auth-storage.js";

const { ensureAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } =
  authProfileStoreRuntime;

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

async function withOAuthTempRoot(
  prefix: string,
  run: (tempRoot: string) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ layout: "state-only", prefix }, async (state) =>
    run(state.stateDir),
  );
}

async function expectSerializedProviderMismatch(params: {
  initial: OAuthCredential;
  beforeLock?: (call: number) => void;
  afterLock?: (call: number, setCredential: (credential: OAuthCredential) => void) => void;
  onCanRefresh?: (setCredential: (credential: OAuthCredential) => void) => void;
}): Promise<void> {
  const profileId = "openai:default";
  let persisted = JSON.stringify({ [profileId]: params.initial });
  let lockCalls = 0;
  const setCredential = (credential: OAuthCredential) => {
    persisted = JSON.stringify({ [profileId]: credential });
  };
  const backend = {
    withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
      lockCalls += 1;
      params.beforeLock?.(lockCalls);
      const update = fn(persisted);
      if (update.next !== undefined) {
        persisted = update.next;
      }
      params.afterLock?.(lockCalls, setCredential);
      return update.result;
    },
  };
  const refreshed = createCredential({
    provider: "provider-b",
    access: "provider-b-access",
    refresh: "provider-b-refresh",
    expires: Date.now() + 600_000,
    accountId: "acct-b",
  });
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
        params.onCanRefresh?.(setCredential);
        return true;
      },
      refresh,
      resolve,
      commit: () => {},
    }),
  ).resolves.toBeNull();
  expect(refresh).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.restoreAllMocks();
  clearAuthProfileMigrationDiagnostics();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawStateDatabaseForTest();
});

describe("AuthStorage OAuth refresh ownership", () => {
  it("refreshes local OAuth credentials while the shared owner requires migration", async () => {
    await withOpenClawTestState(
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
        writePersistedAuthProfileStoreRaw(
          { version: 1, profiles: { [`${providerId}:default`]: credential } },
          agentDir,
        );
        const storage = AuthStorage.forAgent(agentDir, {});
        const refreshed = createCredential({
          provider: providerId,
          access: "synthetic-refreshed-access",
          refresh: "synthetic-refreshed-refresh",
        });
        const refreshToken = vi.fn(async () => refreshed);
        getAuthStorageOAuthProviderRegistry(storage).register({
          id: providerId,
          name: "Test OAuth",
          async login() {
            throw new Error("not used");
          },
          refreshToken,
          getApiKey: (credentials) => credentials.access,
        });
        const fallback = vi.fn(() => "synthetic-fallback-key");
        storage.setFallbackResolver(fallback);

        expect(
          (await storage.getApiKey(providerId)) === refreshed.access,
          "returns the refreshed local credential",
        ).toBe(true);
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
    );
  });

  it.each(["worker", "main"])(
    "blocks credential writes and OAuth refresh when the %s destination requires migration",
    async (agentId) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "auth-write-fence-" },
        async (state) => {
          const agentDir = state.agentDir(agentId);
          await fs.mkdir(agentDir, { recursive: true });
          const originalStore = {
            version: 1,
            profiles: {
              "test-oauth:default": createCredential({ provider: "test-oauth", expires: 1 }),
            },
          };
          writePersistedAuthProfileStoreRaw(originalStore, agentDir);
          const storage = AuthStorage.forAgent(agentDir, {});
          const refreshToken = vi.fn(async () => createCredential({ provider: "test-oauth" }));
          getAuthStorageOAuthProviderRegistry(storage).register({
            id: "test-oauth",
            name: "Test OAuth",
            async login() {
              throw new Error("not used");
            },
            refreshToken,
            getApiKey: (credential) => credential.access,
          });
          // A populated SQLite owner treats legacy files as leftover bytes. Retain
          // the facade's expired credential while its durable owner loses migration admission.
          const migrationStore = { version: 1, profiles: {} };
          writePersistedAuthProfileStoreRaw(migrationStore, agentDir);
          await state.writeJson(
            `agents/${agentId}/agent/auth-profiles.json`,
            agentId === "worker"
              ? { metadata: {} }
              : {
                  version: 1,
                  profiles: {
                    "anthropic:default": {
                      type: "api_key",
                      provider: "anthropic",
                      key: "synthetic-legacy-key",
                    },
                  },
                },
          );
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
      );
    },
  );

  it.each([{ state: "pending", expires: 1 }])(
    "rejects an initial $state credential owned by another provider",
    async ({ state, expires }) => {
      await withOAuthTempRoot(`oauth-manager-provider-${state}-`, async (tempRoot) => {
        const agentDir = path.join(tempRoot, "agents", "main", "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const profileId = "openai:oauth";
        const attempted = createCredential({ expires: 1, accountId: "acct-a" });
        const providerB = createCredential({
          provider: "provider-b",
          access: "provider-b-access",
          refresh: "provider-b-refresh",
          expires,
          accountId: "acct-b",
        });
        const stored =
          state === "pending"
            ? createOAuthRefreshFence({ profileId, credential: providerB })
            : providerB;
        saveAuthProfileStore({ version: 1, profiles: { [profileId]: stored } }, agentDir, {
          filterExternalAuthProfiles: false,
        });

        if (state === "pending") {
          const originalLoad = authProfileStoreRuntime.loadAuthProfileStoreWithoutExternalProfiles;
          let pendingReads = 0;
          vi.spyOn(
            authProfileStoreRuntime,
            "loadAuthProfileStoreWithoutExternalProfiles",
          ).mockImplementation((...args: Parameters<typeof originalLoad>) => {
            const store = originalLoad(...args);
            const credential = store.profiles[profileId];
            if (
              credential?.type === "oauth" &&
              credential.provider === "provider-b" &&
              isPendingOAuthRefreshFence(credential)
            ) {
              pendingReads += 1;
              if (pendingReads > 1) {
                throw new Error("provider-B fence must not be observed");
              }
            }
            return store;
          });
        }

        const buildApiKey = vi.fn(
          async (_provider, credential: OAuthCredential) => credential.access,
        );
        const refreshCredential = vi.fn(async () => providerB);
        const manager = createOAuthManager({
          buildApiKey,
          canRefreshCredential: async () => true,
          refreshCredential,
          readBootstrapCredential: () => null,
        });

        await expect(
          manager.resolveOAuthAccess({
            store: { version: 1, profiles: { [profileId]: attempted } },
            profileId,
            credential: attempted,
            agentDir,
          }),
        ).resolves.toBeNull();
        expect(buildApiKey).not.toHaveBeenCalled();
        expect(refreshCredential).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects a provider change after an OAuth manager compare-and-swap miss", async () => {
    await withOAuthTempRoot("oauth-manager-provider-cas-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const attempted = createCredential({ expires: 1, accountId: "acct-a" });
      const providerB = createCredential({
        provider: "provider-b",
        access: "provider-b-access",
        refresh: "provider-b-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-b",
      });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: attempted } }, agentDir, {
        filterExternalAuthProfiles: false,
      });
      const buildApiKey = vi.fn(
        async (_provider, credential: OAuthCredential) => credential.access,
      );
      const refreshCredential = vi.fn(async () => providerB);
      const manager = createOAuthManager({
        buildApiKey,
        canRefreshCredential: async () => {
          saveAuthProfileStore({ version: 1, profiles: { [profileId]: providerB } }, agentDir, {
            filterExternalAuthProfiles: false,
          });
          return true;
        },
        refreshCredential,
        readBootstrapCredential: () => null,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir),
          profileId,
          credential: attempted,
          agentDir,
        }),
      ).resolves.toBeNull();
      expect(buildApiKey).not.toHaveBeenCalled();
      expect(refreshCredential).not.toHaveBeenCalled();
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(providerB);
    });
  });

  it("stops observing when an OAuth manager fence changes provider", async () => {
    await withOAuthTempRoot("oauth-manager-provider-observer-", async (tempRoot) => {
      const agentDir = path.join(tempRoot, "agents", "main", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const profileId = "openai:oauth";
      const attempted = createCredential({ expires: 1, accountId: "acct-a" });
      const providerAFence = createOAuthRefreshFence({ profileId, credential: attempted });
      const providerB = createCredential({
        provider: "provider-b",
        access: "provider-b-access",
        refresh: "provider-b-refresh",
        expires: Date.now() + 600_000,
        accountId: "acct-b",
      });
      const providerBFence = createOAuthRefreshFence({ profileId, credential: providerB });
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: providerAFence } }, agentDir, {
        filterExternalAuthProfiles: false,
      });

      const originalLoad = authProfileStoreRuntime.loadAuthProfileStoreWithoutExternalProfiles;
      let providerAReads = 0;
      let providerBReads = 0;
      vi.spyOn(
        authProfileStoreRuntime,
        "loadAuthProfileStoreWithoutExternalProfiles",
      ).mockImplementation((...args: Parameters<typeof originalLoad>) => {
        const store = originalLoad(...args);
        const credential = store.profiles[profileId];
        if (credential?.type === "oauth" && credential.provider === "openai") {
          providerAReads += 1;
          if (providerAReads === 2) {
            saveAuthProfileStore(
              { version: 1, profiles: { [profileId]: providerBFence } },
              agentDir,
              { filterExternalAuthProfiles: false },
            );
          }
        } else if (
          credential?.type === "oauth" &&
          credential.provider === "provider-b" &&
          isPendingOAuthRefreshFence(credential)
        ) {
          providerBReads += 1;
          if (providerBReads > 1) {
            throw new Error("provider-B fence observation continued");
          }
        }
        return store;
      });
      const buildApiKey = vi.fn(
        async (_provider, credential: OAuthCredential) => credential.access,
      );
      const manager = createOAuthManager({
        buildApiKey,
        canRefreshCredential: async () => true,
        refreshCredential: vi.fn(async () => null),
        readBootstrapCredential: () => null,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: { version: 1, profiles: { [profileId]: attempted } },
          profileId,
          credential: attempted,
          agentDir,
        }),
      ).resolves.toBeNull();
      expect(buildApiKey).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "pending initial fence",
      initial: createOAuthRefreshFence({
        profileId: "openai:default",
        credential: createCredential({ provider: "provider-b", expires: 1 }),
      }),
      beforeLock: (call: number) => {
        if (call > 1) {
          throw new Error("provider-B fence must not be observed");
        }
      },
    },
    {
      name: "post-canRefresh replacement",
      initial: createCredential({ expires: 1 }),
      onCanRefresh: (setCredential: (credential: OAuthCredential) => void) =>
        setCredential(createCredential({ provider: "provider-b", expires: Date.now() + 600_000 })),
    },
    {
      name: "observer fence replacement",
      initial: createOAuthRefreshFence({
        profileId: "openai:default",
        credential: createCredential({ expires: 1 }),
      }),
      beforeLock: (call: number) => {
        if (call > 2) {
          throw new Error("provider-B fence observation continued");
        }
      },
      afterLock: (call: number, setCredential: (credential: OAuthCredential) => void) => {
        if (call === 1) {
          setCredential(
            createOAuthRefreshFence({
              profileId: "openai:default",
              credential: createCredential({ provider: "provider-b", expires: 1 }),
            }),
          );
        }
      },
    },
  ])("rejects a serialized provider change from a $name", async (scenario) => {
    await expectSerializedProviderMismatch(scenario);
  });

  it("runs provider I/O outside custom backend locks and fences peer retries", async () => {
    const providerId = "test-oauth";
    let persisted = JSON.stringify({
      [providerId]: {
        type: "oauth",
        provider: providerId,
        access: "claimed-access",
        refresh: "claimed-refresh",
        expires: 1,
        accountId: "acct-123",
      },
    });
    let lockDepth = 0;
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        expect(lockDepth).toBe(0);
        lockDepth += 1;
        try {
          const update = fn(persisted);
          if (update.next !== undefined) {
            persisted = update.next;
          }
          return update.result;
        } finally {
          lockDepth -= 1;
        }
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishRefresh:
      | ((credentials: { access: string; refresh: string; expires: number }) => void)
      | undefined;
    const refreshToken = vi.fn(
      () =>
        new Promise<{ access: string; refresh: string; expires: number }>((resolve) => {
          expect(lockDepth).toBe(0);
          finishRefresh = resolve;
          markStarted?.();
        }),
    );
    const provider = {
      id: providerId,
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      refreshToken,
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    };
    const storage = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(storage).register(provider);

    const first = storage.getApiKey(providerId);
    await started;

    expect(persisted).toContain("openclaw-oauth-refresh-fence:v1:");
    expect(persisted).not.toContain("claimed-access");
    expect(persisted).not.toContain("claimed-refresh");
    expect(storage.get(providerId)).toBeUndefined();
    expect(storage.has(providerId)).toBe(false);
    expect(storage.list()).not.toContain(providerId);
    expect(storage.getAll()).toEqual({});
    expect(storage.getAuthStatus(providerId)).toEqual({ configured: false });
    const peer = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(peer).register(provider);
    const peerResult = peer.getApiKey(providerId);
    expect(refreshToken).toHaveBeenCalledTimes(1);

    finishRefresh?.({
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 600_000,
    });
    await expect(first).resolves.toBe("rotated-access");
    await expect(peerResult).resolves.toBe("rotated-access");
    expect(JSON.parse(persisted)).toMatchObject({
      [providerId]: {
        access: "rotated-access",
        refresh: "rotated-refresh",
        accountId: "acct-123",
      },
    });
  });

  it("preserves an expired credential when no refresh owner exists", async () => {
    const providerId = "unowned-oauth";
    const original = {
      type: "oauth",
      provider: providerId,
      access: "unowned-access",
      refresh: "unowned-refresh",
      expires: 1,
    } as const;
    let persisted = JSON.stringify({ [providerId]: original });
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    const storage = AuthStorage.fromStorage(backend);

    await expect(storage.getApiKey(providerId)).resolves.toBeUndefined();
    expect(JSON.parse(persisted)[providerId]).toEqual(original);
  });

  it("does not replay a failed generation and allows environment fallback after restart", async () => {
    const providerId = "xai";
    let persisted = JSON.stringify({
      [providerId]: {
        type: "oauth",
        provider: providerId,
        access: "failed-access",
        refresh: "failed-refresh",
        expires: 1,
      },
    });
    const backend: AuthStorageBackend = {
      withLock: (fn) => {
        const update = fn(persisted);
        if (update.next !== undefined) {
          persisted = update.next;
        }
        return update.result;
      },
      withLockAsync: async () => {
        throw new Error("refresh must not use withLockAsync");
      },
    };
    const refreshToken = vi.fn(async () => {
      throw new Error("simulated provider rejection");
    });
    const provider = {
      id: providerId,
      name: "Failed OAuth",
      async login() {
        throw new Error("not used");
      },
      refreshToken,
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    };
    const first = AuthStorage.fromStorage(backend);
    getAuthStorageOAuthProviderRegistry(first).register(provider);
    await expect(first.getApiKey(providerId)).resolves.toBeUndefined();

    vi.stubEnv("XAI_API_KEY", "environment-fallback");
    try {
      const restarted = AuthStorage.fromStorage(backend);
      getAuthStorageOAuthProviderRegistry(restarted).register(provider);
      await expect(restarted.getApiKey(providerId)).resolves.toBe("environment-fallback");
      expect(refreshToken).toHaveBeenCalledTimes(1);
      expect(persisted).toContain("openclaw-oauth-refresh-fence:v1:");
      expect(persisted).not.toContain("failed-access");
      expect(persisted).not.toContain("failed-refresh");
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
}

function createPublicationCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "test-oauth",
    access: "synthetic-access-a",
    refresh: "synthetic-refresh-a",
    expires: Date.now() + 600_000,
    ...overrides,
  };
}

async function createSqliteAuthRefreshFixture(agentDir: string) {
  await fs.mkdir(agentDir, { recursive: true });
  const providerId = "test-oauth";
  const profileId = `${providerId}:default`;
  const initial = createPublicationCredential({
    provider: providerId,
    expires: 1,
    accountId: "account-a",
  });
  const refreshed = createPublicationCredential({
    provider: providerId,
    access: "synthetic-refreshed-a",
    refresh: "synthetic-refresh-a",
    accountId: "account-a",
  });
  const replacement = createPublicationCredential({
    provider: providerId,
    access: "synthetic-account-b",
    refresh: "synthetic-refresh-b",
    accountId: "account-b",
  });
  writePersistedAuthProfileStoreRaw(
    {
      version: 1,
      profiles: {
        [profileId]: initial,
        "other:default": { type: "api_key", provider: "other", key: "synthetic-other-old" },
      },
    },
    agentDir,
  );
  const storage = AuthStorage.forAgent(agentDir, {});
  const peer = AuthStorage.forAgent(agentDir, {});
  const refreshToken = vi.fn(async () => refreshed);
  getAuthStorageOAuthProviderRegistry(storage).register({
    id: providerId,
    name: "Test OAuth",
    async login() {
      throw new Error("not used");
    },
    refreshToken,
    getApiKey: (credential) => credential.access,
  });
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
    async ({ phase, actor, change }) => {
      await withOpenClawTestState(
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
          if (change === "logout") {
            expect(apiKey).toBeUndefined();
            expect(storage.get(providerId)).toBeUndefined();
            expect(durable?.[profileId]).toBeUndefined();
          } else if (change === "replace") {
            expect(apiKey).toBe(replacement.access);
            expect(storage.get(providerId)).toEqual(replacement);
            expect(durable?.[profileId]).toEqual(replacement);
          } else {
            expect(apiKey).toBe(refreshed.access);
            expect(storage.get(providerId)).toEqual(refreshed);
            expect(durable?.[profileId]).toEqual(refreshed);
          }
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
      );
    },
  );

  it.each(["unchanged", "logout", "replace"])(
    "preserves %s state when an observer publishes a settled credential",
    async (change) => {
      await withOpenClawTestState(
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
      );
    },
  );

  it.each([false, true])(
    "settles claim custody when publication read fails (replacement: %s)",
    async (replace) => {
      await withOpenClawTestState(
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
      );
    },
  );
});
