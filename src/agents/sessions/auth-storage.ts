import fs from "node:fs";
import { dirname } from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AUTH_STORE_VERSION } from "../auth-profiles/constants.js";
import {
  AuthProfileStoreUnreadableError,
  assertAuthProfileMigrationReady,
  assertAuthProfileMigrationCandidates,
} from "../auth-profiles/legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "../auth-profiles/legacy-source-files.js";
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
import {
  createAuthProfileStoreUpdatePublisher,
  runAuthProfileStoreUpdate,
} from "../auth-profiles/store-update.js";
import type {
  AuthProfileCredentialSource,
  AuthProfileStore,
  RuntimeAuthProfileStore,
} from "../auth-profiles/types.js";
import { getAgentDir } from "../config.js";
import {
  AuthStorage as AuthStorageCore,
  InMemoryAuthStorageBackend,
  warnSynchronousAuthStorage,
  type StorageBackend,
} from "./auth-storage-core.js";
import { AuthStoragePersistenceError } from "./auth-storage-error.js";
import {
  applyAuthStorageData,
  assertAuthStorageSecretRefsMaterialized,
  materializeAuthStorageStore,
  projectAuthoritativeAuthStorageData,
} from "./auth-storage-projection.js";
import type { AuthStorageBackend, AuthStorageData, LockResult } from "./auth-storage-types.js";

export type { AuthStatus } from "./auth-storage-core.js";
export type {
  ApiKeyCredential,
  AuthCredential,
  AuthStorageBackend,
  AuthStorageData,
} from "./auth-storage-types.js";
export { OAuthProviderConfiguredUnavailableError } from "./auth-storage-core.js";

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
        selectedStore = applyAuthStorageData(
          store,
          // SAFETY: The AuthStorage mutation serializes its updated credential map into next.
          next ? (JSON.parse(next) as AuthStorageData) : {},
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
            : applyAuthStorageData(
                store,
                // SAFETY: The AuthStorage mutation serializes its updated credential map into next.
                next ? (JSON.parse(next) as AuthStorageData) : {},
                materializedData,
              );
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
      publish: createAuthProfileStoreUpdatePublisher(),
    });
    this.captureCredentialSources(selected.store, selected.databasePath);
    return selected.result;
  }
}

// Standalone SDK factories own persistence and config-backed defaults. Prepared
// catalog callers use the same instance implementation with captured credentials.
export class AuthStorage extends AuthStorageCore {
  private constructor(storage: StorageBackend, data?: AuthStorageData, config?: OpenClawConfig) {
    super(storage, data, config);
  }

  /** @deprecated Use forAgentAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  static forAgent(agentDir: string = getAgentDir(), config?: OpenClawConfig): AuthStorage {
    warnSynchronousAuthStorage("forAgent", "forAgentAsync");
    const scope = createAuthProfileStoreReadScope(agentDir, config);
    const preparedStore = materializeAuthStorageStore(scope.store, scope.getRuntimeSnapshots());
    assertAuthStorageSecretRefsMaterialized(preparedStore);
    return new AuthStorage(new SqliteAuthStorageBackend(scope, preparedStore), undefined, config);
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
    return new AuthStorage(backend, data, config);
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

  static override fromStorage(storage: AuthStorageBackend): AuthStorage {
    return new AuthStorage(storage);
  }

  static override inMemory(data: AuthStorageData = {}): AuthStorage {
    const storage = new InMemoryAuthStorageBackend();
    storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
    return new AuthStorage(storage);
  }
}
