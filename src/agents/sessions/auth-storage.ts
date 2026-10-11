/**
 * Credential storage facade for API keys and OAuth tokens.
 * Canonical persistence is the per-agent SQLite auth-profile store.
 *
 * The backend contract keeps the upstream session SDK shape while OpenClaw
 * projects provider-default profiles into it.
 */

import fs from "node:fs";
import { dirname } from "node:path";
import { findEnvKeys, getEnvApiKey } from "@openclaw/ai/internal/env-api-keys";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OAuthLoginCallbacks, OAuthProviderId } from "../../llm/utils/oauth/types.js";
import { OAuthProviderConfiguredUnavailableError } from "../../plugins/provider-runtime.errors.js";
import { AUTH_STORE_VERSION } from "../auth-profiles/constants.js";
import {
  AuthProfileMigrationRequiredError,
  AuthProfileStoreUnreadableError,
  assertAuthProfileMigrationReady,
} from "../auth-profiles/legacy-source-diagnostic.js";
import { normalizeOAuthRefreshCredential } from "../auth-profiles/oauth-refresh-fence.js";
import {
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
} from "../auth-profiles/oauth-refresh-marker.js";
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
  saveAuthProfileStoreWithPreparedOwner,
} from "../auth-profiles/store-runtime.js";
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
let emittedAuthStorageWarning = false;

class AuthStorageLegacyPathMigrationRequiredError extends Error {
  readonly code = "AUTH_PROFILE_MIGRATION_REQUIRED" as const;
  readonly action = "migrate to AuthStorage.forAgent(agentDir)" as const;

  constructor() {
    super(
      "Deprecated AuthStorage path contains unmigrated credentials; run openclaw doctor --fix for standard agent auth.json or migrate plugin storage to AuthStorage.forAgent(agentDir).",
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

type StorageBackend = Omit<AuthStorageBackend, "withLockAsync">;

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
  ) {}

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
    const store = this.scope.read();
    const content = JSON.stringify(
      projectAuthoritativeAuthStorageData(store, this.resolveMaterializedRuntimeStores()),
    );
    this.captureCredentialSources(store);
    return content;
  }

  private resolveMaterializedRuntimeStores(): AuthProfileStore[] {
    const current = this.scope.getRuntimeSnapshots();
    // A current lifecycle snapshot is authoritative, including an unresolved
    // ref after failed/revoked secrets reload. Prepared data is bootstrap-only.
    return current.length > 0 ? current : [this.preparedStore];
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    assertAuthProfileMigrationReady(this.agentDir);
    const snapshots = this.resolveMaterializedRuntimeStores();
    assertAuthProfileMigrationReady(this.agentDir);
    const selected = runAuthProfileWriteTransaction(this.agentDir, (database, owner) => {
      const store = loadSqliteAuthStorageStore(this.agentDir, database);
      const materializedData = projectAuthoritativeAuthStorageData(store, snapshots);
      const { result, next } = fn(JSON.stringify(materializedData));
      let selectedStore = store;
      if (next !== undefined) {
        selectedStore = applyAuthStorageData(
          store,
          JSON.parse(next) as AuthStorageData,
          materializedData,
        );
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
  private data: AuthStorageData = {};
  private credentialSources = new Map<string, AuthProfileCredentialSource>();
  private runtimeOverrides: Map<string, string> = new Map();
  private fallbackResolver?: (provider: string) => string | undefined;
  private loadError: Error | null = null;
  private errors: Error[] = [];
  private storage: StorageBackend;
  private constructor(storage: StorageBackend) {
    this.storage = storage;
    this.reload();
  }

  static forAgent(agentDir: string = getAgentDir(), config?: OpenClawConfig): AuthStorage {
    const scope = createAuthProfileStoreReadScope(agentDir, config);
    const preparedStore = materializeAuthStorageStore(scope.store, scope.getRuntimeSnapshots());
    assertAuthStorageSecretRefsMaterialized(preparedStore);
    return new AuthStorage(new SqliteAuthStorageBackend(scope, preparedStore));
  }

  /**
   * @deprecated Use AuthStorage.forAgent(agentDir). The path-taking compatibility
   * form is eligible for removal after 2026-10-01 and a clean published-plugin
   * reader sweep; it no longer reads or writes JSON.
   */
  static create(authPath?: string): AuthStorage {
    if (!emittedAuthStorageWarning) {
      emittedAuthStorageWarning = true;
      process.emitWarning(
        "AuthStorage.create(path) is deprecated; use AuthStorage.forAgent(agentDir). The compatibility adapter persists to SQLite and never reads or writes auth.json.",
        { code: "AUTH_STORAGE_CREATE_DEPRECATED", type: "DeprecationWarning" },
      );
    }
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

  private recordError(error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalizedError);
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

  private parseStorageData(content: string | undefined): AuthStorageData {
    if (!content) {
      return {};
    }
    return JSON.parse(content) as AuthStorageData;
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

  reload(): void {
    try {
      const content = this.storage.read
        ? this.storage.read()
        : this.storage.withLock((current) => ({ result: current }));
      this.setData(this.parseStorageData(content));
      this.loadError = null;
    } catch (error) {
      this.loadError = error as Error;
      this.recordError(error);
    }
  }

  private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
    if (this.loadError) {
      this.reload();
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
      const persistedData = this.storage.withLock((current) => {
        const currentData = this.parseStorageData(current);
        const merged: AuthStorageData = { ...currentData };
        if (credential) {
          merged[provider] = credential;
        } else {
          delete merged[provider];
        }
        return { result: merged, next: JSON.stringify(merged, null, 2) };
      });
      this.loadError = null;
      this.setData(persistedData);
    } catch (error) {
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
  }

  get(provider: string): AuthCredential | undefined {
    const credential = this.data[provider];
    return isAuthStorageOAuthRefreshFence(provider, credential) ? undefined : credential;
  }

  set(provider: string, credential: AuthCredential): void {
    this.persistProviderChange(provider, credential);
  }

  remove(provider: string): void {
    this.persistProviderChange(provider, undefined);
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
    this.set(providerId, { type: "oauth", ...credentials });
  }

  logout(provider: string): void {
    this.remove(provider);
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
      storage: this.storage,
      providerId,
      parse: (current) => this.parseStorageData(current),
      commit: (data) => {
        this.setData(data);
        source = this.credentialSources.get(providerId);
        this.loadError = null;
      },
    });
    if (!result) {
      this.reload();
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
      this.reload();
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
          this.reload();
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
      return resolved(this.fallbackResolver?.(providerId) ?? undefined);
    }

    return resolved(undefined);
  }

  getOAuthProviders() {
    return getAuthStorageOAuthProviderRegistry(this).getAll();
  }
}
