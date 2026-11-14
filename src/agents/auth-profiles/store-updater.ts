/** Auth updater surface and its native maintenance/runtime dispatch. */
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { AUTH_STORE_VERSION, authProfilesLog } from "./constants.js";
import { observeCanonicalAuthProfileCredentials } from "./credential-observation.js";
import type { createExternalAuthRuntime } from "./external-auth.js";
import { assertAuthProfileMigrationCandidates } from "./legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "./legacy-source-files.js";
import {
  buildPersistedAuthProfileSecretsStore,
  loadPersistedAuthProfileStoreAtDatabasePath,
} from "./persisted.js";
import { withPersonalAuthProfileStore } from "./personal-store.js";
import type { LoadAuthProfileStoreOptions } from "./runtime-read.js";
import {
  assertPersonalAuthProfileRuntime,
  getScopedAuthProfileEnv,
  getScopedSharedAuthStore,
  getWorkerAuthProfileWrites,
  isEnvOnlyAuthProfileRuntime,
  resolveRuntimeAuthProfileAgentDir,
} from "./runtime-scope.js";
import { getRuntimeAuthProfileStoreSnapshotAtDatabasePath } from "./runtime-snapshots.js";
import { runAuthProfileWriteTransaction, type AuthProfileDatabase } from "./sqlite.js";
import type { SaveAuthProfileStoreOptions } from "./store-save.js";
import {
  AuthProfileSharedSourceChangedError,
  createAuthProfileStoreUpdatePublisher,
  runAuthProfileStoreUpdate,
} from "./store-update.js";
import type { AuthProfileStore, PreparedAuthProfileStoreOwner } from "./types.js";
import { runAuthProfileUsage } from "./usage-lifecycle.js";

export function createAuthProfileStoreUpdater(
  listRuntimeExternalAuthProfiles: ReturnType<
    typeof createExternalAuthRuntime
  >["listRuntimeExternalAuthProfiles"],
  host: {
    applyScopedAuthReadThrough: (store: AuthProfileStore) => AuthProfileStore;
    load: (
      agentDir: string | undefined,
      options: LoadAuthProfileStoreOptions,
      env: NodeJS.ProcessEnv,
    ) => AuthProfileStore;
    save: (
      store: AuthProfileStore,
      agentDir: string | undefined,
      options: SaveAuthProfileStoreOptions | undefined,
      database: AuthProfileDatabase,
      owner: PreparedAuthProfileStoreOwner,
    ) => void;
  },
) {
  const { applyScopedAuthReadThrough } = host;
  /** Update under the write lock; null on contention or changed inherited read facts. */
  return async function updateAuthProfileStoreWithLock(params: {
    agentDir?: string;
    profileId?: string;
    sharedStoreWrite?: boolean;
    stateDir?: string;
    saveOptions?: SaveAuthProfileStoreOptions;
    assertCurrent?: () => void;
    updater: (
      store: AuthProfileStore,
      owner?: PreparedAuthProfileStoreOwner,
      sharedStore?: AuthProfileStore | null,
    ) => boolean;
  }): Promise<AuthProfileStore | null> {
    const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
    const envOnly = isEnvOnlyAuthProfileRuntime();
    try {
      if (params.profileId && isUserModelAuthProfileId(params.profileId)) {
        assertPersonalAuthProfileRuntime();
        params.assertCurrent?.();
        return (
          (await withPersonalAuthProfileStore(
            params.profileId,
            (owner) =>
              owner.update((store) => {
                params.assertCurrent?.();
                const changed = params.updater(store);
                params.assertCurrent?.();
                return changed;
              }, params.assertCurrent),
            params.stateDir,
          )) ?? { version: AUTH_STORE_VERSION, profiles: {} }
        );
      }
      const workerWrites = getWorkerAuthProfileWrites();
      const writeOptions = {
        sharedStoreWrite: params.sharedStoreWrite,
        stateDir: params.stateDir,
        env: params.stateDir ? undefined : (getScopedAuthProfileEnv() ?? workerWrites?.env),
        assertEnvironment: workerWrites?.assertOwner,
      };
      // Doctor keeps maintenance custody; catalog writes stay in their admitted worker request.
      if (workerWrites || getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance) {
        const updateNative = () =>
          runAuthProfileWriteTransaction(
            agentDir,
            (database, owner) => {
              workerWrites?.assertOwner(owner.env);
              params.assertCurrent?.();
              const store = host.load(
                agentDir,
                { database, readOnly: true, syncExternalCli: false },
                owner.env,
              );
              const sharedStore =
                envOnly || owner.databasePath === owner.sharedDatabasePath
                  ? null
                  : loadPersistedAuthProfileStoreAtDatabasePath(
                      owner.sharedDatabasePath,
                      owner.location === "state-db" ? "shared-state" : "agent",
                    );
              const changed = params.updater(store, owner, sharedStore);
              workerWrites?.assertOwner(owner.env);
              params.assertCurrent?.();
              if (changed) {
                host.save(store, agentDir, params.saveOptions, database, owner);
              }
              return store;
            },
            writeOptions,
          );
        return await runAuthProfileUsage(async () =>
          workerWrites ? workerWrites.run(updateNative) : updateNative(),
        );
      }
      let loadedStore: AuthProfileStore;
      await runAuthProfileStoreUpdate({
        agentDir,
        envOnly,
        assertCurrent: params.assertCurrent,
        options: writeOptions,
        update(prepared, owner) {
          if (!envOnly) {
            assertAuthProfileMigrationCandidates({
              databasePath: owner.databasePath,
              candidates: resolveLegacyAuthProfileSourceCandidates({ agentDir, env: owner.env }),
              hasCredentials: () => Object.keys(prepared.store.profiles).length > 0,
            });
            observeCanonicalAuthProfileCredentials(owner.databasePath, prepared.store.profiles);
          }
          loadedStore = applyScopedAuthReadThrough(prepared.store);
          const save = params.updater(loadedStore, owner, prepared.mainStore);
          if (!save) {
            return { save: false };
          }
          const sanitize = (store: AuthProfileStore | undefined) =>
            store && {
              ...store,
              profiles: buildPersistedAuthProfileSecretsStore(store).profiles,
            };
          const options = params.saveOptions;
          const copyIds = (ids: Iterable<string> | undefined) => ids && [...ids];
          return {
            save: true,
            store: sanitize(loadedStore)!,
            scopedSharedStore: sanitize(getScopedSharedAuthStore()),
            externalProfiles:
              options?.filterExternalAuthProfiles !== false
                ? listRuntimeExternalAuthProfiles({ store: loadedStore, agentDir })
                : [],
            runtimeStore:
              options?.filterExternalAuthProfiles !== false
                ? sanitize(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath))
                : undefined,
            options: options && {
              ...options,
              preserveOrderProfileIds: copyIds(options.preserveOrderProfileIds),
              preserveStateProfileIds: copyIds(options.preserveStateProfileIds),
              pruneOrderProfileIds: copyIds(options.pruneOrderProfileIds),
            },
          };
        },
        publish: createAuthProfileStoreUpdatePublisher(
          "Auth store committed before publication failed",
        ),
      });
      return loadedStore!;
    } catch (error) {
      if (error instanceof AuthProfileSharedSourceChangedError) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      authProfilesLog.warn(`auth profile store update failed: ${message}`, {
        agentDir,
        error: message,
      });
      if (!isSqliteLockError(error)) {
        throw error;
      }
      return null;
    }
  };
}
