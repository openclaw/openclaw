import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AuthStorage as PublicAuthStorage,
  ModelRegistry as PublicModelRegistry,
} from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { OAuthProviderInterface } from "../../llm/utils/oauth/types.js";
import * as sdkDeprecation from "../../plugins/sdk-deprecation.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";

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
import { refreshAuthProfileFileState } from "../auth-profiles/file-state.js";
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
  let tempDir: string;
  let agentDir: string;
  const unreadableStore = { version: 1, profiles: "invalid-profile-map" };
  const expiredOAuth = {
    type: "oauth" as const,
    provider: "test-oauth",
    access: "fake-expired-access",
    refresh: "fake-refresh",
    expires: 1,
  };
  const secretRuntimeError =
    "requires the active secrets runtime to materialize SecretRef credentials";
  const identity = { accountId: "fake-account-id", email: "fake-user@example.com" };

  function writeProfiles(profiles: unknown) {
    writePersistedAuthProfileStoreRaw({ version: 1, profiles }, agentDir);
  }

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

  function oauthProvider(
    refreshToken: OAuthProviderInterface["refreshToken"],
  ): OAuthProviderInterface {
    return {
      id: "test-oauth",
      name: "Test OAuth",
      async login() {
        throw new Error("not used");
      },
      refreshToken,
      getApiKey: (credentials) => credentials.access,
    };
  }

  beforeEach(() => {
    tempDir = agentDir = fs.mkdtempSync(path.join(tmpdir(), "auth-sqlite-"));
    providerOAuthMocks.login.mockReset().mockResolvedValue({ status: "unowned" });
    providerOAuthMocks.resolveCredential.mockReset().mockResolvedValue({ status: "unowned" });
  });

  afterEach(() => {
    clearAuthProfileMigrationDiagnostics();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes detached in-memory credentials without a legacy reload warning", () => {
    const warn = vi.spyOn(sdkDeprecation, "warnPluginSdkDeprecation").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const credential = { type: "api_key" as const, key: "synthetic-initial-key" };
    const storage = PublicAuthStorage.inMemory({ fixture: credential });
    credential.key = "synthetic-mutated-key";

    expect(storage.get("fixture")).toEqual({ type: "api_key", key: "synthetic-initial-key" });
    expect(warn).not.toHaveBeenCalled();

    storage.reload();
    expect(warn).toHaveBeenCalledWith({
      family: "auth-profile-sync-operations",
      method: "AuthStorage.reload",
      replacement: "AuthStorage.reloadAsync",
    });
    expect(storage.get("fixture")).toEqual({ type: "api_key", key: "synthetic-initial-key" });
  });

  it("merges async SDK writes and reloads committed peer changes without host SQLite", async () => {
    await withWorkerState("auth-async-sdk-", async () => {
      const left = await PublicAuthStorage.forAgentAsync(agentDir);
      const right = await PublicAuthStorage.forAgentAsync(agentDir);
      await withoutHostSql(async () => {
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

    expect(() => storage.set("anthropic", { type: "api_key", key: "fake-new-key" })).toThrow(
      "is unreadable",
    );
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadableStore);
    expect(storage.has("anthropic")).toBe(false);
  });

  it("blocks environment fallback after a canonical store becomes unreadable", async () => {
    const storage = AuthStorage.forAgent(agentDir);
    writePersistedAuthProfileStoreRaw(unreadableStore, agentDir);
    await refreshAuthProfileFileState();
    vi.stubEnv("OPENAI_API_KEY", "fake-environment-key");
    storage.reload();

    await expect(storage.getApiKey("openai")).rejects.toThrow("is unreadable");
  });

  it("never overwrites a store that becomes unreadable during an OAuth refresh", async () => {
    writeProfiles({ "test-oauth:default": expiredOAuth });
    const storage = AuthStorage.forAgent(agentDir);
    getAuthStorageOAuthProviderRegistry(storage).register(oauthProvider(async () => freshOAuth()));
    writePersistedAuthProfileStoreRaw(unreadableStore, agentDir);

    await expect(storage.getApiKey("test-oauth")).rejects.toThrow("is unreadable");
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
      oauthProvider(async () => {
        fs.writeFileSync(path.join(agentDir, "auth.json"), '{"legacy":true}\n', "utf8");
        return freshOAuth({ access: "not-a-real", refresh: "not-a-real" });
      }),
    );

    // The store already owns this profile, so a retired file appearing mid-call is
    // leftover bytes: discarding a completed refresh over it would strand the agent
    // on an expired token. Doctor never overwrites a usable stored credential.
    await expect(storage.getApiKey("test-oauth")).resolves.toBe("not-a-real");
    expect(
      loadPersistedAuthProfileStore(agentDir)?.profiles["test-oauth:default"],
    ).not.toMatchObject({ expires: 1 });
  });

  it("keeps stored OAuth identity fields through the published agent sessions SDK", async () => {
    writeProfiles({
      "test-oauth:default": {
        ...expiredOAuth,
        ...identity,
        subscriptionType: "max",
        rateLimitTier: "default_max_20x",
      },
    });
    const storage = await PublicAuthStorage.forAgentAsync(agentDir);
    PublicModelRegistry.inMemory(storage).registerProvider("test-oauth", {
      oauth: oauthProvider(async () => freshOAuth({ refresh: "fake-rotated-refresh" })),
    });

    await withoutHostSql(async () => {
      await expect(storage.getApiKey("test-oauth")).resolves.toBe("fake-fresh-access");
    });
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["test-oauth:default"]).toMatchObject({
      type: "oauth",
      provider: "test-oauth",
      access: "fake-fresh-access",
      refresh: "fake-rotated-refresh",
      ...identity,
      subscriptionType: "max",
      rateLimitTier: "default_max_20x",
    });
    expect(storage.get("test-oauth")).toMatchObject(identity);
  });

  it("keeps AuthStorage.create(path) as a named SQLite-backed deprecation", () => {
    const legacyPath = path.join(agentDir, "auth.json");
    const storage = AuthStorage.create(legacyPath);
    storage.set("openai", { type: "api_key", key: "fake-openai-key" });

    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:default"]).toMatchObject({
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
    storage.set("anthropic", { type: "api_key", key: "fake-anthropic-key" });

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

    AuthStorage.forAgent(agentDir).set("anthropic", {
      type: "api_key",
      key: "not-a-real",
    });

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
    let refreshCalls = 0;
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const provider = oauthProvider(async () => {
      refreshCalls += 1;
      activeRefreshes += 1;
      maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
      refreshEntered.resolve();
      await releaseRefresh.promise;
      activeRefreshes -= 1;
      return freshOAuth();
    });
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
      await expect(Promise.all([ownerKey, peerKey])).resolves.toEqual([
        "fake-fresh-access",
        undefined,
      ]);
    } finally {
      releaseRefresh.resolve();
    }
    expect([refreshCalls, maxActiveRefreshes]).toEqual([1, 1]);
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
