/**
 * Credential storage facade for API keys and OAuth tokens.
 * Canonical persistence is the per-agent SQLite auth-profile store.
 *
 * The backend contract keeps the upstream session SDK shape while OpenClaw
 * projects provider-default profiles into it.
 */

import fs from "node:fs";
import { dirname } from "node:path";
import { findEnvKeys, getEnvApiKey } from "@openclaw/ai/internal/runtime";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OAuthLoginCallbacks, OAuthProviderId } from "../../llm/utils/oauth/types.js";
import { OAuthProviderConfiguredUnavailableError } from "../../plugins/provider-runtime.errors.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { AUTH_STORE_VERSION } from "../auth-profiles/constants.js";
import {
  AuthProfileMigrationRequiredError,
  AuthProfileStoreUnreadableError,
  assertAuthProfileMigrationReady,
  assertAuthProfileMigrationCandidates,
} from "../auth-profiles/legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "../auth-profiles/legacy-source-files.js";
import { normalizeOAuthRefreshCredential } from "../auth-profiles/oauth-refresh-fence.js";
import {
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "../auth-profiles/oauth-refresh-marker.js";
import { resolveAuthStorePathForDisplayAsync } from "../auth-profiles/paths.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  type AuthProfileDatabase,
} from "../auth-profiles/sqlite.js";
import { loadPersistedAuthProfileState } from "../auth-profiles/state.js";
import {
  createAuthProfileStoreReadScope,
  createAuthProfileStoreReadScopeAsync,
  saveAuthProfileStoreWithPreparedOwner,
} from "../auth-profiles/store-runtime.js";
import { publishAuthProfileStoreUpdate } from "../auth-profiles/store-update-publication.js";
import { runAuthProfileStoreUpdate } from "../auth-profiles/store-update.js";
import type {
  AuthProfileCredentialSource,
  AuthProfileStore,
  RuntimeAuthProfileStore,
} from "../auth-profiles/types.js";
import { getAgentDir } from "../config.js";
import { AuthStoragePersistenceError } from "./auth-storage-error.js";
import {
  isAuthStorageOAuthRefreshFence,
  refreshAuthStorageOAuthCredential,
} from "./auth-storage-oauth-refresh.js";
import {
  getAuthStorageOAuthProviderRegistry,
  loginAuthStorageOAuthProvider,
  resolveAuthStoragePluginOAuthCredential,
} from "./auth-storage-oauth-registry.js";
import {
  applyAuthStorageData,
  assertAuthStorageSecretRefsMaterialized,
  materializeAuthStorageStore,
  projectAuthoritativeAuthStorageData,
} from "./auth-storage-projection.js";
import type {
  AuthCredential,
  AuthStorageBackend,
  AuthStorageData,
  LockResult,
} from "./auth-storage-types.js";
import { resolveConfigValue } from "./resolve-config-value.js";

export type {
  ApiKeyCredential,
  AuthCredential,
  AuthStorageBackend,
  AuthStorageData,
} from "./auth-storage-types.js";
export { OAuthProviderConfiguredUnavailableError };

function warnSynchronousAuthStorage(method: string, replacement: string): void {
  warnPluginSdkDeprecation({
    family: "auth-profile-sync-operations",
    method: `AuthStorage.${method}`,
    replacement: `AuthStorage.${replacement}`,
  });
}

class AuthStorageLegacyPathMigrationRequiredError extends Error {
  readonly code = "AUTH_PROFILE_MIGRATION_REQUIRED" as const;
  readonly action = "migrate to AuthStorage.forAgentAsync(agentDir)" as const;

  constructor() {
    super(
      "Deprecated AuthStorage path contains unmigrated credentials; run openclaw doctor --fix for standard agent auth.json or migrate plugin storage to AuthStorage.forAgentAsync(agentDir).",
    );
    this.name = "AuthStorageLegacyPathMigrationRequiredError";
  }
}

function assertDeprecatedAuthStoragePathAbsent(authPath: string | undefined): void {
  // Deprecated adapters use this path only to derive the SQLite owner and
  // never create or write it. An existing file is therefore unmigrated input.
  if (authPath && fs.existsSync(authPath)) {
    throw new AuthStorageLegacyPathMigrationRequiredError();
  }
}

export type AuthStatus = {
  configured: boolean;
  source?:
    | "stored"
    | "runtime"
    | "environment"
    | "fallback"
    | "models_json_key"
    | "models_json_command";
  label?: string;
};

type StorageBackend = Omit<AuthStorageBackend, "withLockAsync"> & {
  readAsync?: () => Promise<string | undefined>;
  updateAsync?: <T>(fn: (current: string | undefined) => LockResult<T>) => Promise<T>;
};

function parseStorageData(content: string | undefined): AuthStorageData {
  if (!content) {
    return {};
  }
  return JSON.parse(content) as AuthStorageData;
}

function collectStateOnlyAuthProfileIds(store: AuthProfileStore): string[] {
  const referenced = new Set([
    ...Object.values(store.order ?? {}).flat(),
    ...Object.values(store.lastGood ?? {}),
    ...Object.keys(store.usageStats ?? {}),
  ]);
  return [...referenced].filter((profileId) => !store.profiles[profileId]);
}

function loadSqliteAuthStorageStore(
  agentDir: string,
  database?: AuthProfileDatabase,
): AuthProfileStore {
  const inspection = inspectPersistedAuthProfileStoreRaw(agentDir, database);
  if (inspection.status === "missing") {
    const stateInspection = inspectPersistedAuthProfileStateRaw(agentDir, database);
    if (stateInspection.status === "unreadable") {
      throw new AuthProfileStoreUnreadableError(
        database?.path ?? resolveAuthProfileDatabasePath(agentDir),
      );
    }
    return {
      version: AUTH_STORE_VERSION,
      profiles: {},
      ...loadPersistedAuthProfileState(agentDir, database),
    };
  }
  const store = loadPersistedAuthProfileStore(agentDir, database ? { database } : undefined);
  if (inspection.status === "unreadable" || !store) {
    throw new AuthProfileStoreUnreadableError(
      database?.path ?? resolveAuthProfileDatabasePath(agentDir),
    );
  }
  return store;
}

class SqliteAuthStorageBackend implements StorageBackend {
  private credentialSources = new Map<string, AuthProfileCredentialSource>();

  constructor(
    private readonly scope: ReturnType<typeof createAuthProfileStoreReadScope>,
    private readonly preparedStore: AuthProfileStore,
    private readonly asyncOnly = false,
  ) {
    this.captureCredentialSources(preparedStore);
  }

  private get agentDir(): string {
    return this.scope.agentDir;
  }

  assertProviderReady(provider?: string, baseUrl?: string): void {
    this.scope.assertProviderReady(provider, baseUrl);
  }

  getCredentialSource(provider: string): AuthProfileCredentialSource | undefined {
    return this.credentialSources.get(provider);
  }

  assertCredentialReady(source: AuthProfileCredentialSource, baseUrl?: string): void {
    this.scope.assertCredentialReady(source, baseUrl);
  }

  private captureCredentialSources(store: RuntimeAuthProfileStore, databasePath?: string): void {
    const persisted = new Set(store.runtimePersistedProfileIds ?? []);
    this.credentialSources = new Map(
      Object.entries(store.profiles).flatMap(([profileId, credential]) => {
        if (profileId !== `${credential.provider}:default`) {
          return [];
        }
        const source = databasePath
          ? { databasePath, provider: credential.provider }
          : store.runtimeCredentialSources?.[profileId];
        if (!source && persisted.has(profileId)) {
          throw new AuthStoragePersistenceError(
            "Canonical auth credential is missing its source owner.",
            undefined,
          );
        }
        return source ? [[credential.provider, source]] : [];
      }),
    );
  }

  read(): string {
    this.assertSynchronousAccess("reloadAsync");
    return this.projectRead(this.scope.read());
  }

  async readAsync(): Promise<string> {
    return this.projectRead(await this.scope.readAsync());
  }

  private projectRead(store: RuntimeAuthProfileStore): string {
    const content = JSON.stringify(
      projectAuthoritativeAuthStorageData(store, this.resolveMaterializedRuntimeStores()),
    );
    this.captureCredentialSources(store);
    return content;
  }

  private assertSynchronousAccess(replacement: string): void {
    if (this.asyncOnly) {
      throw new Error(`This AuthStorage instance requires ${replacement}().`);
    }
  }

  private resolveMaterializedRuntimeStores(): AuthProfileStore[] {
    const current = this.scope.getRuntimeSnapshots();
    // A current lifecycle snapshot is authoritative, including an unresolved
    // ref after failed/revoked secrets reload. Prepared data is bootstrap-only.
    return current.length > 0 ? current : [this.preparedStore];
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.assertSynchronousAccess("setAsync() or removeAsync");
    const snapshots = this.resolveMaterializedRuntimeStores();
    assertAuthProfileMigrationReady(this.agentDir);
    const selected = runAuthProfileWriteTransaction(this.agentDir, (database, owner) => {
      const store = loadSqliteAuthStorageStore(this.agentDir, database);
      const materializedData = projectAuthoritativeAuthStorageData(store, snapshots);
      const { result, next } = fn(JSON.stringify(materializedData));
      let selectedStore = store;
      if (next !== undefined) {
        selectedStore = applyAuthStorageData(store, parseStorageData(next), materializedData);
        saveAuthProfileStoreWithPreparedOwner(
          selectedStore,
          this.agentDir,
          {
            filterExternalAuthProfiles: false,
            preserveStateProfileIds: collectStateOnlyAuthProfileIds(store),
            syncExternalCli: false,
          },
          database,
          owner,
        );
      }
      return { result, store: selectedStore, databasePath: owner.databasePath };
    });
    this.captureCredentialSources(selected.store, selected.databasePath);
    return selected.result;
  }

  async updateAsync<T>(fn: (current: string | undefined) => LockResult<T>): Promise<T> {
    let selected!: { result: T; store: AuthProfileStore; databasePath: string };
    await runAuthProfileStoreUpdate({
      agentDir: this.agentDir,
      envOnly: this.scope.envOnly,
      options: { env: this.scope.env },
      update: ({ store }, owner) => {
        assertAuthProfileMigrationCandidates({
          databasePath: owner.databasePath,
          candidates: resolveLegacyAuthProfileSourceCandidates({
            agentDir: this.agentDir,
            env: owner.env,
          }),
          hasCredentials: () => Object.keys(store.profiles).length > 0,
        });
        const materializedData = projectAuthoritativeAuthStorageData(
          store,
          this.resolveMaterializedRuntimeStores(),
        );
        const { result, next } = fn(JSON.stringify(materializedData));
        const nextStore =
          next === undefined
            ? store
            : applyAuthStorageData(store, parseStorageData(next), materializedData);
        selected = { result, store: nextStore, databasePath: owner.databasePath };
        return next === undefined
          ? { save: false }
          : {
              save: true,
              store: nextStore,
              externalProfiles: [],
              options: {
                filterExternalAuthProfiles: false,
                preserveStateProfileIds: collectStateOnlyAuthProfileIds(store),
                syncExternalCli: false,
              },
            };
      },
      async publish(committed, owner, assertCurrent, nativeCommits, committedIsCurrent) {
        if (committed) {
          await publishAuthProfileStoreUpdate(
            owner,
            committed,
            assertCurrent,
            nativeCommits,
            committedIsCurrent,
          );
        }
      },
    });
    this.captureCredentialSources(selected.store, selected.databasePath);
    return selected.result;
  }
}

class InMemoryAuthStorageBackend implements StorageBackend {
  private value: string | undefined;

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const { result, next } = fn(this.value);
    if (next !== undefined) {
      this.value = next;
    }
    return result;
  }
}

/**
 * Provider-keyed credential facade backed by the canonical auth-profile store.
 */
export class AuthStorage {
  /** Resolve the selected auth store's display path without loading credentials. */
  static resolvePathForDisplayAsync = resolveAuthStorePathForDisplayAsync;

  private data: AuthStorageData = {};
  private credentialSources = new Map<string, AuthProfileCredentialSource>();
  private runtimeOverrides: Map<string, string> = new Map();
  private fallbackResolver?: (provider: string) => string | undefined;
  private loadError: Error | null = null;
  private errors: Error[] = [];
  private storage: StorageBackend;
  private constructor(storage: StorageBackend, data?: AuthStorageData) {
    this.storage = storage;
    if (data) {
      this.setData(data);
    } else {
      this.loadFromStorage();
    }
  }

  /** @deprecated Use forAgentAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  static forAgent(agentDir: string = getAgentDir(), config?: OpenClawConfig): AuthStorage {
    warnSynchronousAuthStorage("forAgent", "forAgentAsync");
    const scope = createAuthProfileStoreReadScope(agentDir, config);
    const preparedStore = materializeAuthStorageStore(scope.store, scope.getRuntimeSnapshots());
    assertAuthStorageSecretRefsMaterialized(preparedStore);
    return new AuthStorage(new SqliteAuthStorageBackend(scope, preparedStore));
  }

  static async forAgentAsync(
    agentDir: string = getAgentDir(),
    config?: OpenClawConfig,
  ): Promise<AuthStorage> {
    const scope = await createAuthProfileStoreReadScopeAsync(agentDir, config);
    const preparedStore = materializeAuthStorageStore(scope.store, scope.getRuntimeSnapshots());
    assertAuthStorageSecretRefsMaterialized(preparedStore);
    const backend = new SqliteAuthStorageBackend(scope, preparedStore, true);
    const data = projectAuthoritativeAuthStorageData(scope.store, scope.getRuntimeSnapshots());
    return new AuthStorage(backend, data);
  }

  /**
   * @deprecated Use AuthStorage.forAgentAsync(agentDir). The path-taking compatibility
   * form remains supported through 2026-12-31; removal ships in the first
   * January 2027 stable. It no longer reads or writes JSON.
   */
  static create(authPath?: string): AuthStorage {
    warnSynchronousAuthStorage("create", "forAgentAsync");
    assertDeprecatedAuthStoragePathAbsent(authPath);
    return AuthStorage.forAgent(authPath ? dirname(authPath) : getAgentDir(), undefined);
  }

  static fromStorage(storage: AuthStorageBackend): AuthStorage {
    return new AuthStorage(storage);
  }

  static inMemory(data: AuthStorageData = {}): AuthStorage {
    const storage = new InMemoryAuthStorageBackend();
    storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
    return new AuthStorage(storage);
  }

  /**
   * Set a runtime API key override (not persisted to disk).
   * Used for CLI --api-key flag.
   */
  setRuntimeApiKey(provider: string, apiKey: string): void {
    this.runtimeOverrides.set(provider, apiKey);
  }

  removeRuntimeApiKey(provider: string): void {
    this.runtimeOverrides.delete(provider);
  }

  /**
   * Set a fallback resolver for API keys not found in canonical storage or env vars.
   * Used for custom provider keys from models.json.
   */
  setFallbackResolver(resolver: (provider: string) => string | undefined): void {
    this.fallbackResolver = resolver;
  }

  private recordError(error: unknown): Error {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalizedError);
    return normalizedError;
  }

  private getCanonicalLoadError(): Error | null {
    if (!this.loadError) {
      return null;
    }
    return this.storage.assertProviderReady ||
      this.loadError instanceof AuthProfileMigrationRequiredError ||
      this.loadError instanceof AuthProfileStoreUnreadableError
      ? this.loadError
      : null;
  }

  private assertProviderReady(providerId: string, options?: { baseUrl?: string }): void {
    this.storage.assertProviderReady?.(providerId, options?.baseUrl);
    const error = this.getCanonicalLoadError();
    if (error) {
      // Canonical-store ownership blocks implicit env/config fallback.
      throw error;
    }
  }

  private setData(data: AuthStorageData): void {
    this.data = data;
    this.credentialSources = new Map(
      Object.keys(data).flatMap((provider) => {
        const source = this.storage.getCredentialSource?.(provider);
        return source ? [[provider, source]] : [];
      }),
    );
  }

  /** @deprecated Use reloadAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  reload(): void {
    warnSynchronousAuthStorage("reload", "reloadAsync");
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    try {
      const content = this.storage.read
        ? this.storage.read()
        : this.storage.withLock((current) => ({ result: current }));
      this.setData(parseStorageData(content));
      this.loadError = null;
    } catch (error) {
      this.loadError = this.recordError(error);
    }
  }

  async reloadAsync(): Promise<void> {
    try {
      const content = this.storage.readAsync
        ? await this.storage.readAsync()
        : this.storage.read
          ? this.storage.read()
          : this.storage.withLock((current) => ({ result: current }));
      this.setData(parseStorageData(content));
      this.loadError = null;
    } catch (error) {
      this.loadError = this.recordError(error);
    }
  }

  private mergeProviderChange(
    current: string | undefined,
    provider: string,
    credential: AuthCredential | undefined,
  ): LockResult<AuthStorageData> {
    const merged = { ...parseStorageData(current) };
    if (credential) {
      merged[provider] = credential;
    } else {
      delete merged[provider];
    }
    return { result: merged, next: JSON.stringify(merged, null, 2) };
  }

  private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
    if (this.loadError) {
      this.loadFromStorage();
    }

    if (this.loadError) {
      const error = new AuthStoragePersistenceError(
        `Cannot update auth storage because it could not be loaded: ${this.loadError.message}`,
        this.loadError,
      );
      this.recordError(error);
      throw error;
    }

    try {
      const persistedData = this.storage.withLock((current) =>
        this.mergeProviderChange(current, provider, credential),
      );
      this.loadError = null;
      this.setData(persistedData);
    } catch (error) {
      this.failProviderChange(provider, error);
    }
  }

  private async persistProviderChangeAsync(
    provider: string,
    credential: AuthCredential | undefined,
  ): Promise<void> {
    try {
      const update = (current: string | undefined) =>
        this.mergeProviderChange(current, provider, credential);
      const persistedData = this.storage.updateAsync
        ? await this.storage.updateAsync(update)
        : this.storage.withLock(update);
      this.loadError = null;
      this.setData(persistedData);
    } catch (error) {
      this.failProviderChange(provider, error);
    }
  }

  private failProviderChange(provider: string, error: unknown): never {
    const persistenceError =
      error instanceof AuthStoragePersistenceError
        ? error
        : new AuthStoragePersistenceError(
            `Failed to persist auth storage update for provider "${provider}": ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
    this.recordError(persistenceError);
    throw persistenceError;
  }

  get(provider: string): AuthCredential | undefined {
    const credential = this.data[provider];
    return isAuthStorageOAuthRefreshFence(provider, credential) ? undefined : credential;
  }

  /** @deprecated Use setAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  set(provider: string, credential: AuthCredential): void {
    warnSynchronousAuthStorage("set", "setAsync");
    this.persistProviderChange(provider, credential);
  }

  setAsync(provider: string, credential: AuthCredential): Promise<void> {
    return this.persistProviderChangeAsync(provider, credential);
  }

  /** @deprecated Use removeAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  remove(provider: string): void {
    warnSynchronousAuthStorage("remove", "removeAsync");
    this.persistProviderChange(provider, undefined);
  }

  removeAsync(provider: string): Promise<void> {
    return this.persistProviderChangeAsync(provider, undefined);
  }

  list(): string[] {
    return Object.keys(this.data).filter(
      (provider) => !isAuthStorageOAuthRefreshFence(provider, this.data[provider]),
    );
  }

  has(provider: string): boolean {
    return this.get(provider) !== undefined;
  }

  /**
   * Check if any form of auth is configured for a provider.
   * Unlike getApiKey(), this doesn't refresh OAuth tokens.
   */
  hasAuth(provider: string): boolean {
    return Boolean(
      this.runtimeOverrides.has(provider) ||
      this.get(provider) ||
      getEnvApiKey(provider) ||
      this.fallbackResolver?.(provider),
    );
  }

  /**
   * Return auth status without exposing credential values or refreshing tokens.
   */
  getAuthStatus(provider: string): AuthStatus {
    if (this.get(provider)) {
      return { configured: true, source: "stored" };
    }

    if (this.runtimeOverrides.has(provider)) {
      return { configured: false, source: "runtime", label: "--api-key" };
    }

    const envKeys = findEnvKeys(provider);
    if (envKeys?.[0]) {
      return { configured: false, source: "environment", label: envKeys[0] };
    }

    if (this.fallbackResolver?.(provider)) {
      return { configured: false, source: "fallback", label: "custom provider config" };
    }

    return { configured: false };
  }

  /**
   * Get all credentials (for passing to getOAuthApiKey).
   */
  getAll(): AuthStorageData {
    return Object.fromEntries(
      Object.entries(this.data).filter(
        ([provider, credential]) => !isAuthStorageOAuthRefreshFence(provider, credential),
      ),
    );
  }

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
    const credentials = await loginAuthStorageOAuthProvider(this, providerId, callbacks);
    await this.setAsync(providerId, { type: "oauth", ...credentials });
  }

  /** @deprecated Use logoutAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  logout(provider: string): void {
    warnSynchronousAuthStorage("logout", "logoutAsync");
    this.remove(provider);
  }

  logoutAsync(provider: string): Promise<void> {
    return this.removeAsync(provider);
  }

  /**
   * Refresh OAuth token with backend locking to prevent race conditions.
   * Multiple agent sessions may try to refresh simultaneously when tokens expire.
   */
  private async refreshOAuthTokenWithLock(providerId: OAuthProviderId): Promise<{
    apiKey: string;
    source?: AuthProfileCredentialSource;
  } | null> {
    let source: AuthProfileCredentialSource | undefined;
    const result = await refreshAuthStorageOAuthCredential({
      authStorage: this,
      storage: {
        withLock: (update) =>
          this.storage.updateAsync
            ? this.storage.updateAsync(update)
            : this.storage.withLock(update),
      },
      providerId,
      parse: parseStorageData,
      commit: (data) => {
        this.setData(data);
        source = this.credentialSources.get(providerId);
        this.loadError = null;
      },
    });
    if (!result) {
      await this.reloadAsync();
      return null;
    }
    return { ...result, source };
  }

  /**
   * Get API key for a provider.
   * Priority:
   * 1. Runtime override (CLI --api-key)
   * 2. API key from canonical storage
   * 3. OAuth token from canonical storage (auto-refreshed with locking)
   * 4. Environment variable
   * 5. Fallback resolver (models.json custom providers)
   */
  async getApiKey(
    providerId: string,
    options?: { includeFallback?: boolean; baseUrl?: string },
  ): Promise<string | undefined> {
    const runtimeKey = this.runtimeOverrides.get(providerId);
    if (runtimeKey) {
      return runtimeKey;
    }

    if (this.storage.readAsync) {
      await this.reloadAsync();
    }
    this.assertProviderReady(providerId, options);
    const { apiKey, source } = await this.resolveStoredOrFallbackApiKey(providerId, options);
    this.assertProviderReady(providerId, options);
    if (source) {
      this.storage.assertCredentialReady?.(source, options?.baseUrl);
    }
    return apiKey;
  }

  private async resolveStoredOrFallbackApiKey(
    providerId: string,
    options?: { includeFallback?: boolean; baseUrl?: string },
  ): Promise<{ apiKey: string | undefined; source?: AuthProfileCredentialSource }> {
    let cred = this.data[providerId];
    if (isAuthStorageOAuthRefreshFence(providerId, cred)) {
      await this.reloadAsync();
      cred = this.data[providerId];
      const normalizedFence =
        cred?.type === "oauth" ? normalizeOAuthRefreshCredential(cred, providerId) : undefined;
      if (isOAuthRefreshFence(normalizedFence) && !isPendingOAuthRefreshFence(normalizedFence)) {
        cred = undefined;
      }
    }
    let source = this.credentialSources.get(providerId);
    if (source) {
      this.storage.assertCredentialReady?.(source, options?.baseUrl);
    }
    const resolved = (apiKey: string | undefined) => ({ apiKey, source });

    if (cred?.type === "api_key") {
      return resolved(resolveConfigValue(cred.key));
    }

    if (cred?.type === "token") {
      if (cred.expires === undefined || Date.now() < cred.expires) {
        return resolved(resolveConfigValue(cred.token));
      }
    }

    if (cred?.type === "oauth") {
      const provider = getAuthStorageOAuthProviderRegistry(this).get(providerId);

      if (Date.now() >= cred.expires) {
        try {
          const result = await this.refreshOAuthTokenWithLock(providerId);
          if (result) {
            return { apiKey: result.apiKey, source: result.source };
          }
        } catch (error) {
          if (error instanceof OAuthProviderConfiguredUnavailableError) {
            throw error;
          }
          this.recordError(error);
          // Refresh failed - reload the store in case another instance succeeded
          await this.reloadAsync();
          const canonicalStoreError =
            error instanceof AuthProfileMigrationRequiredError ||
            error instanceof AuthProfileStoreUnreadableError
              ? error
              : this.getCanonicalLoadError();
          if (canonicalStoreError) {
            throw canonicalStoreError;
          }
          const updatedCred = this.data[providerId];
          source = this.credentialSources.get(providerId);
          if (source) {
            this.storage.assertCredentialReady?.(source, options?.baseUrl);
          }

          if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
            if (provider) {
              return resolved(provider.getApiKey(updatedCred));
            }
            return resolved(
              (await resolveAuthStoragePluginOAuthCredential(providerId, updatedCred, false))
                ?.apiKey,
            );
          }

          // Refresh truly failed - return undefined so model discovery skips this provider
          // User can /login to re-authenticate (credentials preserved for retry)
          return resolved(undefined);
        }
      } else {
        if (provider) {
          return resolved(provider.getApiKey(cred));
        }
        return resolved(
          (await resolveAuthStoragePluginOAuthCredential(providerId, cred, false))?.apiKey,
        );
      }
    }

    const envKey = getEnvApiKey(providerId);
    if (envKey) {
      return resolved(envKey);
    }

    if (options?.includeFallback !== false) {
      return resolved(this.fallbackResolver?.(providerId));
    }

    return resolved(undefined);
  }

  getOAuthProviders() {
    return getAuthStorageOAuthProviderRegistry(this).getAll();
  }
}
