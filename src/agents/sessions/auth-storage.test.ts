// Auth storage tests cover the provider-keyed SDK facade over canonical SQLite auth profiles.
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AuthStorage as PublicAuthStorage,
  ModelRegistry as PublicModelRegistry,
} from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../auth-profiles/credential-fixtures.test-support.js";

const providerOAuthMocks = vi.hoisted(() => ({
  login: vi.fn(),
  resolveCredential: vi.fn(),
}));

vi.mock("../../plugins/provider-runtime.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.runtime.js")>(
    "../../plugins/provider-runtime.runtime.js",
  );
  return {
    ...actual,
    loginProviderOAuthWithPlugin: providerOAuthMocks.login,
    resolveProviderOAuthCredentialWithPlugin: providerOAuthMocks.resolveCredential,
  };
});
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  assertAuthProfileMigrationReady,
  clearAuthProfileMigrationDiagnostics,
} from "../auth-profiles/legacy-source-diagnostic.js";
import { isPendingOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
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
import * as authProfileStoreUpdate from "../auth-profiles/store-update.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import { AuthStorage, OAuthProviderConfiguredUnavailableError } from "./auth-storage.js";

describe("SQLite auth storage", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    providerOAuthMocks.login.mockReset();
    providerOAuthMocks.login.mockResolvedValue({ status: "unowned" });
    providerOAuthMocks.resolveCredential.mockReset();
    providerOAuthMocks.resolveCredential.mockResolvedValue({ status: "unowned" });
  });

  afterEach(() => {
    clearAuthProfileMigrationDiagnostics();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeAgentDir(): string {
    const agentDir = fs.mkdtempSync(path.join(tmpdir(), "auth-sqlite-"));
    tempDirs.push(agentDir);
    return agentDir;
  }

  it("merges async SDK writes and reloads committed peer changes without host SQLite", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "auth-async-sdk-" },
      async (state) => {
        const agentDir = state.agentDir("worker");
        fs.mkdirSync(agentDir, { recursive: true });
        const left = await PublicAuthStorage.forAgentAsync(agentDir);
        const right = await PublicAuthStorage.forAgentAsync(agentDir);
        const sql = observeHostDataSql();
        try {
          await Promise.all([
            left.setAsync("openai", { type: "api_key", key: "synthetic-openai" }),
            right.setAsync("anthropic", { type: "api_key", key: "synthetic-anthropic" }),
          ]);
          await left.reloadAsync();
          expect(left.list().toSorted()).toEqual(["anthropic", "openai"]);
          await right.removeAsync("openai");
          await left.reloadAsync();
          expect(left.get("openai")).toBeUndefined();
          expect(await left.getApiKey("anthropic")).toBe("synthetic-anthropic");
          expect(
            sql.queries.filter((query) => /\bauth_profile_(?:store|state)\b/i.test(query)),
          ).toEqual([]);
        } finally {
          sql.restore();
        }
      },
    );
  });

  it("dispatches callback-based login to the owning provider plugin", async () => {
    const agentDir = makeAgentDir();
    const storage = await AuthStorage.forAgentAsync(agentDir);
    const callbacks = {
      onAuth: vi.fn(),
      onPrompt: vi.fn(async () => ""),
    };
    providerOAuthMocks.login.mockResolvedValueOnce({
      status: "available",
      credentials: {
        access: "fake-access",
        refresh: "fake-refresh",
        expires: Date.now() + 60_000,
      },
    });

    await storage.login("plugin-oauth", callbacks);

    expect(providerOAuthMocks.login).toHaveBeenCalledWith({
      provider: "plugin-oauth",
      context: callbacks,
    });
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["plugin-oauth:default"]).toMatchObject(
      {
        type: "oauth",
        provider: "plugin-oauth",
        access: "fake-access",
        refresh: "fake-refresh",
      },
    );
  });

  it("returns a typed actionable error when an owned OAuth plugin is unavailable", async () => {
    const storage = AuthStorage.forAgent(makeAgentDir());
    providerOAuthMocks.login.mockResolvedValueOnce({ status: "configured-unavailable" });

    const login = storage.login("plugin-oauth", {
      onAuth: vi.fn(),
      onPrompt: vi.fn(async () => ""),
    });
    await expect(login).rejects.toMatchObject({
      name: "OAuthProviderConfiguredUnavailableError",
      code: "OAUTH_PROVIDER_CONFIGURED_UNAVAILABLE",
      state: "configured-unavailable",
      providerId: "plugin-oauth",
    });
    await expect(login).rejects.toBeInstanceOf(OAuthProviderConfiguredUnavailableError);
  });

  it("never overwrites a store that becomes unreadable before a synchronous write", () => {
    const agentDir = makeAgentDir();
    const storage = AuthStorage.forAgent(agentDir);
    const unreadableStore = { version: 1, profiles: "invalid-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadableStore, agentDir);

    expect(() => storage.set("anthropic", { type: "api_key", key: "fake-new-key" })).toThrow(
      "is unreadable",
    );
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadableStore);
    expect(storage.has("anthropic")).toBe(false);
  });

  it("blocks environment fallback after a canonical store becomes unreadable", async () => {
    const agentDir = makeAgentDir();
    const storage = AuthStorage.forAgent(agentDir);
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: "invalid-profile-map" }, agentDir);
    vi.stubEnv("OPENAI_API_KEY", "fake-environment-key");
    storage.reload();

    await expect(storage.getApiKey("openai")).rejects.toThrow("is unreadable");
  });

  it("never overwrites a store that becomes unreadable during an OAuth refresh", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "test-oauth:default": {
          type: "oauth",
          provider: "test-oauth",
          access: "fake-expired-access",
          refresh: "fake-refresh",
          expires: 1,
        },
      }),
      agentDir,
    );
    const storage = AuthStorage.forAgent(agentDir);
    getAuthStorageOAuthProviderRegistry(storage).register({
      id: "test-oauth",
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      async refreshToken() {
        return {
          access: "fake-fresh-access",
          refresh: "fake-refresh",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    });
    const unreadableStore = { version: 1, profiles: "invalid-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadableStore, agentDir);

    await expect(storage.getApiKey("test-oauth")).rejects.toThrow("is unreadable");
    expect(storage.drainErrors().some((error) => error.message.includes("is unreadable"))).toBe(
      true,
    );
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadableStore);
  });

  it("does not commit a refresh when a legacy source appears during the provider call", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "test-oauth:default": {
          type: "oauth",
          provider: "test-oauth",
          access: "not-a-real",
          refresh: "not-a-real",
          expires: 1,
        },
      }),
      agentDir,
    );
    const storage = AuthStorage.forAgent(agentDir);
    getAuthStorageOAuthProviderRegistry(storage).register({
      id: "test-oauth",
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      async refreshToken() {
        fs.writeFileSync(path.join(agentDir, "auth.json"), '{"legacy":true}\n', "utf8");
        return {
          access: "not-a-real",
          refresh: "not-a-real",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    });

    // The store already owns this profile, so a retired file appearing mid-call is
    // leftover bytes: discarding a completed refresh over it would strand the agent
    // on an expired token. Doctor never overwrites a usable stored credential.
    await expect(storage.getApiKey("test-oauth")).resolves.toBe("not-a-real");
    expect(
      loadPersistedAuthProfileStore(agentDir)?.profiles["test-oauth:default"],
    ).not.toMatchObject({ expires: 1 });
  });

  it("keeps stored OAuth identity fields through the published agent sessions SDK", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "test-oauth:default": {
          type: "oauth",
          provider: "test-oauth",
          access: "fake-expired-access",
          refresh: "fake-refresh",
          expires: 1,
          accountId: "fake-account-id",
          email: "fake-user@example.com",
          subscriptionType: "max",
          rateLimitTier: "default_max_20x",
        },
      }),
      agentDir,
    );
    const storage = await PublicAuthStorage.forAgentAsync(agentDir);
    PublicModelRegistry.inMemory(storage).registerProvider("test-oauth", {
      oauth: {
        name: "Test OAuth",
        async login() {
          throw new Error("not used");
        },
        async refreshToken() {
          return {
            access: "fake-fresh-access",
            refresh: "fake-rotated-refresh",
            expires: Date.now() + 60_000,
          };
        },
        getApiKey(credentials: { access: string }) {
          return credentials.access;
        },
      },
    });

    const sql = observeHostDataSql();
    try {
      await expect(storage.getApiKey("test-oauth")).resolves.toBe("fake-fresh-access");
      expect(
        sql.queries.filter((query) => /\bauth_profile_(?:store|state)\b/i.test(query)),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["test-oauth:default"]).toMatchObject({
      type: "oauth",
      provider: "test-oauth",
      access: "fake-fresh-access",
      refresh: "fake-rotated-refresh",
      accountId: "fake-account-id",
      email: "fake-user@example.com",
      subscriptionType: "max",
      rateLimitTier: "default_max_20x",
    });
    expect(storage.get("test-oauth")).toMatchObject({
      accountId: "fake-account-id",
      email: "fake-user@example.com",
    });
  });

  it("keeps AuthStorage.create(path) as a named SQLite-backed deprecation", () => {
    const agentDir = makeAgentDir();
    const legacyPath = path.join(agentDir, "auth.json");
    const storage = AuthStorage.create(legacyPath);
    storage.set("openai", { type: "api_key", key: "fake-openai-key" });

    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
      key: "fake-openai-key",
    });
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("fails closed instead of ignoring credentials at a deprecated custom path", () => {
    const agentDir = makeAgentDir();
    const customPath = path.join(agentDir, "plugin-credentials.json");
    fs.writeFileSync(customPath, '{"openai":{"key":"not-a-real"}}\n', "utf8");

    expect(() => AuthStorage.create(customPath)).toThrow(
      expect.objectContaining({ code: "AUTH_PROFILE_MIGRATION_REQUIRED" }),
    );
    expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
  });

  it("reads materialized SecretRefs without persisting their resolved value", async () => {
    const agentDir = makeAgentDir();
    vi.stubEnv("OPENAI_API_KEY", "fake-ambient-key");
    const keyRef = { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" };
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "openai:default": { type: "api_key", provider: "openai", keyRef },
        "xai:default": {
          type: "token",
          provider: "xai",
          tokenRef: { source: "env", provider: "default", id: "XAI_TOKEN" },
        },
      }),
      agentDir,
    );
    expect(() => AuthStorage.forAgent(agentDir)).toThrow(
      "requires the active secrets runtime to materialize SecretRef credentials",
    );
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: createAuthProfileStoreFixture({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef,
            key: "fake-materialized-key",
          },
          "xai:default": {
            type: "token",
            provider: "xai",
            tokenRef: { source: "env", provider: "default", id: "XAI_TOKEN" },
            token: "fake-materialized-token",
          },
        }),
      },
    ]);

    const storage = AuthStorage.forAgent(agentDir);
    expect(await storage.getApiKey("openai")).toBe("fake-materialized-key");
    expect(await storage.getApiKey("xai")).toBe("fake-materialized-token");
    storage.set("anthropic", { type: "api_key", key: "fake-anthropic-key" });

    const persisted = readPersistedAuthProfileStoreRaw(agentDir) as {
      profiles: Record<string, { key?: string; keyRef?: unknown }>;
    };
    expect(persisted).toMatchObject({
      profiles: {
        "openai:default": { keyRef },
      },
    });
    expect(persisted.profiles["openai:default"]?.key).toBeUndefined();
    storage.remove("openai");
    expect(
      (readPersistedAuthProfileStoreRaw(agentDir) as { profiles: Record<string, unknown> })
        .profiles["openai:default"],
    ).toBeUndefined();
  });

  it("does not reuse a materialized value after its persisted SecretRef changes", async () => {
    const agentDir = makeAgentDir();
    const originalRef = { source: "env" as const, provider: "default", id: "QA_AUTH_REF_OLD" };
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "openai:default": { type: "api_key", provider: "openai", keyRef: originalRef },
      }),
      agentDir,
    );
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: createAuthProfileStoreFixture({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: originalRef,
            key: "not-a-real",
          },
        }),
      },
    ]);
    const storage = AuthStorage.forAgent(agentDir);
    expect(await storage.getApiKey("openai")).toBe("not-a-real");

    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "QA_AUTH_REF_NEW" },
        },
      }),
      agentDir,
    );
    clearRuntimeAuthProfileStoreSnapshots();
    storage.reload();

    await expect(storage.getApiKey("openai")).rejects.toThrow(
      "requires the active secrets runtime to materialize SecretRef credentials",
    );
  });

  it("does not reuse prepared materialization when the current snapshot is unresolved", async () => {
    const agentDir = makeAgentDir();
    const keyRef = { source: "env" as const, provider: "default", id: "QA_AUTH_REF" };
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "openai:default": { type: "api_key", provider: "openai", keyRef },
      }),
      agentDir,
    );
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: createAuthProfileStoreFixture({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef,
            key: "not-a-real",
          },
        }),
      },
    ]);
    const storage = AuthStorage.forAgent(agentDir);
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: createAuthProfileStoreFixture({
          "openai:default": { type: "api_key", provider: "openai", keyRef },
        }),
      },
    ]);

    storage.reload();

    await expect(storage.getApiKey("openai")).rejects.toThrow(
      "requires the active secrets runtime to materialize SecretRef credentials",
    );
  });

  it("preserves state-only SQLite rows when adding credentials", () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStateRaw(
      {
        version: 1,
        order: { openai: ["openai:default"] },
        lastGood: { openai: "openai:default" },
        usageStats: { "openai:default": { cooldownUntil: 1_900_000_000_000 } },
      },
      agentDir,
    );

    AuthStorage.forAgent(agentDir).set("anthropic", {
      type: "api_key",
      key: "not-a-real",
    });

    expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic" },
      },
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
      usageStats: { "openai:default": { cooldownUntil: 1_900_000_000_000 } },
    });
  });

  it("revalidates widened shared refusals on the next credential request without reload", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "auth-shared-refusal-" },
      async (state) => {
        const agentDir = state.agentDir("worker");
        fs.mkdirSync(agentDir, { recursive: true });
        writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, agentDir);
        const profiles = {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "synthetic-legacy-key",
          },
        };
        await state.writeJson("agents/main/agent/auth-profiles.json", { version: 1, profiles });
        const storage = AuthStorage.forAgent(agentDir);
        storage.setFallbackResolver(() => "synthetic-fallback-key");
        await expect(storage.getApiKey("nvidia")).resolves.toBeDefined();
        await state.writeJson("agents/main/agent/auth-profiles.json", {
          version: 1,
          profiles: {
            ...profiles,
            "nvidia:default": {
              type: "api_key",
              provider: "nvidia",
              key: "synthetic-new-legacy-key",
            },
          },
        });
        expect(() => assertAuthProfileMigrationReady(undefined, undefined, "nvidia")).toThrow(
          "requires legacy credential migration",
        );
        await expect(storage.getApiKey("nvidia")).rejects.toMatchObject({
          code: "AUTH_PROFILE_MIGRATION_REQUIRED",
          affectedProviders: ["anthropic", "nvidia"],
        });
      },
    );
  });

  it("fails closed when a legacy credential source appears after construction", async () => {
    const agentDir = makeAgentDir();
    const storage = AuthStorage.forAgent(agentDir);
    vi.stubEnv("OPENAI_API_KEY", "fake-environment-key");
    fs.writeFileSync(path.join(agentDir, "auth.json"), '{"openai":{"key":"fake-late"}}\n');

    await expect(storage.getApiKey("openai")).rejects.toThrow(
      "requires legacy credential migration",
    );
  });

  it("ignores unresolved named profiles outside the provider-default facade", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "openai:work": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_WORK_KEY" },
        },
        "anthropic:default": createApiKeyCredential("anthropic", "fake-anthropic-key"),
      }),
      agentDir,
    );

    await expect(AuthStorage.forAgent(agentDir).getApiKey("anthropic")).resolves.toBe(
      "fake-anthropic-key",
    );
  });

  it("fails closed for an identityless SQLite peer until the owner commits its rotation", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "test-oauth:default": {
          type: "oauth",
          provider: "test-oauth",
          access: "fake-expired-access",
          refresh: "fake-refresh",
          expires: 1,
        },
      }),
      agentDir,
    );
    const left = AuthStorage.forAgent(agentDir);
    const right = AuthStorage.forAgent(agentDir);
    const refreshEntered = createDeferredCore();
    const releaseRefresh = createDeferredCore();
    let refreshCalls = 0;
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const provider = {
      id: "test-oauth",
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      async refreshToken() {
        refreshCalls += 1;
        activeRefreshes += 1;
        maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
        refreshEntered.resolve();
        await releaseRefresh.promise;
        activeRefreshes -= 1;
        return {
          access: "fake-fresh-access",
          refresh: "fake-refresh",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey(credentials: { access: string }) {
        return credentials.access;
      },
    };
    getAuthStorageOAuthProviderRegistry(left).register(provider);
    getAuthStorageOAuthProviderRegistry(right).register(provider);

    const ownerKey = left.getApiKey("test-oauth");
    try {
      await refreshEntered.promise;
      const peerSelected = createDeferredCore();
      const runUpdate = authProfileStoreUpdate.runAuthProfileStoreUpdate;
      const observePeer = vi
        .spyOn(authProfileStoreUpdate, "runAuthProfileStoreUpdate")
        .mockImplementationOnce((params) => {
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
        });
      onTestFinished(() => observePeer.mockRestore());
      const peerKey = right.getApiKey("test-oauth");
      void peerKey.catch(peerSelected.reject);
      await peerSelected.promise;
      releaseRefresh.resolve();
      await expect(peerKey).resolves.toBeUndefined();
      await expect(Promise.all([ownerKey, peerKey])).resolves.toEqual([
        "fake-fresh-access",
        undefined,
      ]);
    } finally {
      releaseRefresh.resolve();
    }
    expect(refreshCalls).toBe(1);
    expect(maxActiveRefreshes).toBe(1);
    await expect(right.getApiKey("test-oauth")).resolves.toBe("fake-fresh-access");
  });

  it("falls back to environment auth when a stored token is expired", async () => {
    const agentDir = makeAgentDir();
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "xai:default": {
          type: "token",
          provider: "xai",
          token: "fake-expired-token",
          expires: 1,
        },
      }),
      agentDir,
    );
    vi.stubEnv("XAI_API_KEY", "fake-environment-key");

    await expect(AuthStorage.forAgent(agentDir).getApiKey("xai")).resolves.toBe(
      "fake-environment-key",
    );
  });
});
