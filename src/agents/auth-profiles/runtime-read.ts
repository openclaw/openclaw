/** Runtime auth reads compose worker-prepared facts through the store's captured host scope. */
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  getActiveOpenClawStateDatabaseReadSnapshot,
  isArtifactPreservingStateRead,
} from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import type { createExternalAuthRuntime } from "./external-auth.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import { loadInheritedAuthProfileStore } from "./inherited-store.js";
import {
  assertAuthProfileMigrationCandidates,
  assertAuthProfileMigrationStateAtDatabasePath,
} from "./legacy-source-diagnostic.js";
import {
  resolveLegacyAuthProfileSourceCandidates,
  type LegacyAuthProfileSource,
} from "./legacy-source-files.js";
import {
  getRuntimeAuthProfileStoreCredentialMutationToken,
  type RuntimeAuthProfileStoreMutationOwner,
} from "./mutation-lineage.js";
import { readOAuthRefreshGenerationDigest } from "./oauth-refresh-marker.js";
import { captureOAuthRefreshSettlement } from "./oauth-refresh-observation.js";
import {
  captureAuthProfileOwnerScope,
  resolveSharedAuthStoreOwnershipAsync,
  resolveSharedAuthStorePath as resolveSharedAuthPath,
} from "./path-resolve.js";
import { mergeAuthProfileStores } from "./persisted.js";
import {
  materializePersonalAuthProfile,
  materializePreparedPersonalAuthProfile,
} from "./personal-profiles.js";
import {
  createEmptyAuthProfileStore,
  listRuntimeLocalProfileIds,
  runtimeStoreInheritsMainState,
  setRuntimeLocalProfileMetadata,
} from "./runtime-snapshot-owner.js";
import {
  captureRuntimeAuthProfileLocalPin,
  runtimeAuthProfileRowsCache,
} from "./runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readSharedAuthProfileRows,
  readUserModelAuthProfileAsync,
} from "./sqlite-read.js";
import {
  resolveAuthProfileDatabasePath as resolveAgentAuthPath,
  resolveAuthProfileDatabaseOwnerId,
  type AuthProfileDatabase,
} from "./sqlite.js";
import type { AuthProfileStore, AuthProfileRowRead } from "./types.js";

export type LoadAuthProfileStoreOptions = {
  /** Limit a credential-read refusal to the provider being resolved; writes stay owner-wide. */
  migrationProvider?: string;
  deferScopedMigrationRefusals?: boolean;
  onReadOwner?: (owner: AuthProfileReadOwner) => void;
  /** Materialize only this explicitly selected personal account into the returned view. */
  profileId?: string;
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  database?: AuthProfileDatabase;
  externalCli?: ExternalCliAuthDiscovery;
  inheritedAuthDir?: string;
  readOnly?: boolean;
  syncExternalCli?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

export type AuthProfileReadOwner = {
  databasePath: string;
  candidates: LegacyAuthProfileSource[];
  readStore: () => AuthProfileStore | null;
};

export type ResolvedExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

export function resolveExternalCliOverlayOptions(
  options: LoadAuthProfileStoreOptions | undefined,
): ResolvedExternalCliOverlayOptions {
  const discovery = options?.externalCli;
  const config = discovery?.config ?? options?.config;
  if (discovery?.mode === "none") {
    return {
      allowKeychainPrompt: false,
      ...(config ? { config } : {}),
      externalCliProviderIds: [],
      externalCliProfileIds: [],
    };
  }
  const allowKeychainPrompt = discovery?.allowKeychainPrompt ?? options?.allowKeychainPrompt;
  const providerIds = !discovery
    ? options?.externalCliProviderIds
    : discovery.mode === "scoped"
      ? discovery.providerIds
      : undefined;
  const profileIds = !discovery
    ? options?.externalCliProfileIds
    : discovery.mode === "scoped"
      ? discovery.profileIds
      : undefined;
  return {
    ...(allowKeychainPrompt !== undefined ? { allowKeychainPrompt } : {}),
    ...(config ? { config } : {}),
    ...(providerIds ? { externalCliProviderIds: providerIds } : {}),
    ...(profileIds ? { externalCliProfileIds: profileIds } : {}),
  };
}

type RuntimeReadHost = {
  isEnvOnlyAuthProfileRuntime: () => boolean;
  getScopedAuthProfileEnv: () => NodeJS.ProcessEnv | undefined;
  resolveRuntimeAuthProfileAgentDir: (agentDir?: string) => string | undefined;
  resolveRuntimeAuthProfileLoadOptions: (
    options?: LoadAuthProfileStoreOptions,
  ) => LoadAuthProfileStoreOptions | undefined;
  loadAuthProfileStoreForAgent: (
    agentDir?: string,
    options?: LoadAuthProfileStoreOptions,
    env?: NodeJS.ProcessEnv,
    preparedRows?: AuthProfileRowRead,
  ) => AuthProfileStore;
  overlayExternalAuthProfiles: ReturnType<
    typeof createExternalAuthRuntime
  >["overlayExternalAuthProfiles"];
  captureScope: () => {
    isolated: boolean;
    run: <T>(agentDir: string | undefined, env: NodeJS.ProcessEnv, run: () => T) => T;
  };
};

/** Bind to the canonical store scope; this reader owns no mutable runtime or lifecycle state. */
export function createAuthProfileStoreRuntimeReader({
  isEnvOnlyAuthProfileRuntime,
  getScopedAuthProfileEnv,
  resolveRuntimeAuthProfileAgentDir,
  resolveRuntimeAuthProfileLoadOptions,
  loadAuthProfileStoreForAgent,
  overlayExternalAuthProfiles,
  captureScope,
}: RuntimeReadHost) {
  /**
   * Synchronous SDK compatibility. Runtime callers should await loadAuthProfileStoreForRuntimeAsync;
   * transaction-bound SDK callers retain this entrypoint until their own async cutover.
   */
  function loadAuthProfileStoreForRuntime(
    agentDir?: string,
    options?: LoadAuthProfileStoreOptions,
    env?: NodeJS.ProcessEnv,
  ): AuthProfileStore {
    return loadRuntimeAuthProfileStore(agentDir, options, env);
  }

  function loadRuntimeAuthProfileStore(
    agentDir?: string,
    options?: LoadAuthProfileStoreOptions,
    env?: NodeJS.ProcessEnv,
    readPreparedStore?: (databasePath: string) => AuthProfileStore,
  ): AuthProfileStore {
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    if (options?.profileId && isUserModelAuthProfileId(options.profileId)) {
      const shared = loadAuthProfileStoreForRuntime(
        agentDir,
        { ...options, profileId: undefined },
        env,
      );
      return captureScope().isolated
        ? shared
        : materializePersonalAuthProfile(shared, options.profileId);
    }
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const effectiveOptions = resolveRuntimeAuthProfileLoadOptions(options);
    const authPath = effectiveAgentDir
      ? resolveAgentAuthPath(effectiveAgentDir)
      : resolveSharedAuthPath(env);
    const store = readPreparedStore
      ? readPreparedStore(authPath)
      : loadAuthProfileStoreForAgent(effectiveAgentDir, effectiveOptions, env);
    const mainAuthPath = effectiveOptions?.inheritedAuthDir
      ? resolveAgentAuthPath(effectiveOptions.inheritedAuthDir)
      : resolveSharedAuthPath(env);
    const externalCli = resolveExternalCliOverlayOptions(effectiveOptions);
    if (!effectiveAgentDir || authPath === mainAuthPath) {
      return setRuntimeLocalProfileMetadata(
        overlayExternalAuthProfiles(store, {
          agentDir: effectiveAgentDir,
          ...(env ? { env } : {}),
          ...externalCli,
        }),
        listRuntimeLocalProfileIds(store),
      );
    }

    const mainStore = loadInheritedAuthProfileStore(
      () =>
        readPreparedStore
          ? readPreparedStore(mainAuthPath)
          : loadAuthProfileStoreForAgent(effectiveOptions?.inheritedAuthDir, effectiveOptions, env),
      effectiveOptions?.inheritedAuthDir,
      env ?? getScopedAuthProfileEnv(),
    );
    const mergedStore = mainStore
      ? mergeAuthProfileStores(mainStore, store, { preserveBaseRuntimeExternalProfiles: true })
      : store;
    return setRuntimeLocalProfileMetadata(
      overlayExternalAuthProfiles(mergedStore, {
        agentDir: effectiveAgentDir,
        ...(env ? { env } : {}),
        ...externalCli,
      }),
      listRuntimeLocalProfileIds(store, mainStore),
      runtimeStoreInheritsMainState(mergedStore, store),
    );
  }

  /** Read persisted facts off-thread; scoped overlays and live setup selection stay on the host. */
  async function loadAuthProfileStoreForRuntimeAsync(
    agentDir?: string,
    options?: Omit<LoadAuthProfileStoreOptions, "database" | "onReadOwner" | "syncExternalCli">,
  ): Promise<AuthProfileStore> {
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    const scope = captureScope();
    const env = cloneEnvWithPlatformSemantics(getScopedAuthProfileEnv() ?? process.env);
    env.OPENCLAW_STATE_DIR = resolveStateDir(env);
    const reusePersistedRows =
      !scope.isolated &&
      !isArtifactPreservingStateRead() &&
      !getOpenClawDatabaseMaintenanceScope() &&
      !getActiveOpenClawStateDatabaseReadSnapshot({ env });
    const selectedDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const effectiveAgentDir = selectedDir
      ? path.dirname(resolveAgentAuthPath(selectedDir))
      : undefined;
    const selectedAgentPath = effectiveAgentDir
      ? resolveAgentAuthPath(effectiveAgentDir)
      : undefined;
    const scopedOptions = resolveRuntimeAuthProfileLoadOptions(options);
    const inheritedDir = scopedOptions?.inheritedAuthDir;
    const inheritedAuthDir = inheritedDir
      ? path.dirname(resolveAgentAuthPath(inheritedDir))
      : undefined;
    const externalCli = scopedOptions?.externalCli;
    const capturedOptions: LoadAuthProfileStoreOptions = {
      ...scopedOptions,
      inheritedAuthDir,
      readOnly: true,
      externalCli:
        externalCli?.mode === "scoped"
          ? {
              ...externalCli,
              ...(externalCli.providerIds ? { providerIds: [...externalCli.providerIds] } : {}),
              ...(externalCli.profileIds ? { profileIds: [...externalCli.profileIds] } : {}),
            }
          : externalCli,
      ...(scopedOptions?.externalCliProviderIds
        ? { externalCliProviderIds: [...scopedOptions.externalCliProviderIds] }
        : {}),
      ...(scopedOptions?.externalCliProfileIds
        ? { externalCliProfileIds: [...scopedOptions.externalCliProfileIds] }
        : {}),
    };
    const profileId = capturedOptions.profileId;
    const localMutationOwner: RuntimeAuthProfileStoreMutationOwner | undefined = selectedAgentPath
      ? {
          kind: "unresolved",
          databasePath: selectedAgentPath,
          scope: captureAuthProfileOwnerScope(env),
        }
      : undefined;
    const readLocalToken = () =>
      localMutationOwner && profileId
        ? getRuntimeAuthProfileStoreCredentialMutationToken(undefined, profileId, {
            owner: localMutationOwner,
          })
        : undefined;
    const pinnedLocal =
      reusePersistedRows && effectiveAgentDir && profileId
        ? captureRuntimeAuthProfileLocalPin(resolveAgentAuthPath(effectiveAgentDir), profileId)
        : undefined;
    const pinnedLocalToken = pinnedLocal ? readLocalToken() : undefined;
    const personalProfileId =
      !scope.isolated && profileId && isUserModelAuthProfileId(profileId) ? profileId : undefined;
    const needsSharedStore = !effectiveAgentDir || !inheritedAuthDir;
    let sharedContext: ReturnType<typeof captureOpenClawStateWorkerContext> | undefined;
    let sharedPreparationFailure: { error: unknown } | undefined;
    try {
      if (needsSharedStore || personalProfileId) {
        sharedContext = captureOpenClawStateWorkerContext({ env });
      }
    } catch (error) {
      // Capture now, but preserve selected-store refusal before an inherited-owner failure.
      sharedPreparationFailure = { error };
    }
    const legacySharedPath = resolveAgentAuthPath(resolveSharedMainAuthAgentDir(env));
    const agentReads = new Map(
      [
        ...new Set([
          ...(needsSharedStore ? [legacySharedPath] : []),
          ...(effectiveAgentDir ? [resolveAgentAuthPath(effectiveAgentDir)] : []),
          ...(effectiveAgentDir && inheritedAuthDir
            ? [resolveAgentAuthPath(inheritedAuthDir)]
            : []),
        ]),
      ].map((databasePath) => [
        databasePath,
        prepareAgentAuthProfileRowsRead({
          databasePath,
          agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
          env,
        }),
      ]),
    );
    const inCapturedScope = <T>(run: () => T): T => scope.run(effectiveAgentDir, env, run);
    const stores = new Map<string, Result<AuthProfileStore, unknown>>();
    let localRowsToken: ReturnType<typeof readLocalToken>;
    let inheritedObservationPath: string | undefined;
    const readOwners = new Map<string, AuthProfileReadOwner>();
    const rowReaders = new Map<
      string,
      Pick<ReturnType<typeof prepareAgentAuthProfileRowsRead>, "assertCurrent">
    >();
    const readOwner = async (
      ownerAgentDir: string | undefined,
      databasePath: string,
      reader: Pick<ReturnType<typeof prepareAgentAuthProfileRowsRead>, "read" | "assertCurrent">,
    ) => {
      assertAuthProfileMigrationStateAtDatabasePath(
        databasePath,
        capturedOptions.migrationProvider,
        capturedOptions.config,
        capturedOptions.deferScopedMigrationRefusals,
      );
      const candidates = resolveLegacyAuthProfileSourceCandidates({ agentDir: ownerAgentDir, env });
      if (databasePath === selectedAgentPath) {
        localRowsToken = readLocalToken();
      }
      const preparedReader = reusePersistedRows
        ? runtimeAuthProfileRowsCache.prepare(
            databasePath,
            reader,
            (databasePaths, capturedRows) => {
              const currentLocalToken = readLocalToken();
              const localFactIsCurrent = (token: ReturnType<typeof readLocalToken>) =>
                token?.known === true &&
                currentLocalToken?.known === true &&
                token.revision === currentLocalToken.revision;
              const local = selectedAgentPath ? stores.get(selectedAgentPath) : undefined;
              const localStore = local?.ok
                ? local.value
                : databasePath === selectedAgentPath &&
                    capturedRows &&
                    capturedRows.store.status !== "unreadable"
                  ? loadPersistedAuthProfileStoreFromRows(capturedRows, databasePath)
                  : undefined;
              let localOwner: string | undefined;
              if (localFactIsCurrent(localRowsToken) && profileId && localStore) {
                const inherited = inheritedObservationPath
                  ? stores.get(inheritedObservationPath)
                  : undefined;
                const inheritedStore = inherited?.ok
                  ? inherited.value
                  : databasePath === inheritedObservationPath &&
                      capturedRows &&
                      capturedRows.store.status !== "unreadable"
                    ? loadPersistedAuthProfileStoreFromRows(capturedRows, databasePath)
                    : undefined;
                // Actual rows take precedence over warm metadata after foreign writes.
                if (inheritedStore && inheritedObservationPath !== selectedAgentPath) {
                  localOwner = listRuntimeLocalProfileIds(localStore, inheritedStore).includes(
                    profileId,
                  )
                    ? selectedAgentPath
                    : undefined;
                } else if (
                  localFactIsCurrent(pinnedLocalToken) &&
                  pinnedLocal?.matchesCredential(localStore.profiles[profileId])
                ) {
                  localOwner = pinnedLocal.databasePath;
                }
              }
              const localCredential = profileId ? localStore?.profiles[profileId] : undefined;
              return captureOAuthRefreshSettlement({
                databasePaths,
                localPin: localOwner
                  ? {
                      databasePath: localOwner,
                      generation:
                        profileId && localCredential?.type === "oauth"
                          ? readOAuthRefreshGenerationDigest({
                              profileId,
                              credential: localCredential,
                            })
                          : undefined,
                    }
                  : undefined,
                profileId,
                matchesProvider: (provider) =>
                  inCapturedScope(
                    () =>
                      !capturedOptions.migrationProvider ||
                      resolveProviderIdForAuth(provider, {
                        config: capturedOptions.config,
                        env,
                        storedCredential: true,
                      }) ===
                        resolveProviderIdForAuth(capturedOptions.migrationProvider, {
                          config: capturedOptions.config,
                          env,
                        }),
                  ),
              });
            },
          )
        : reader;
      rowReaders.set(databasePath, preparedReader);
      const rows = await preparedReader.read();
      preparedReader.assertCurrent();
      stores.set(databasePath, {
        ok: true,
        value: inCapturedScope(() =>
          loadAuthProfileStoreForAgent(ownerAgentDir, capturedOptions, env, rows),
        ),
      });
      readOwners.set(databasePath, {
        databasePath,
        candidates,
        readStore: () => loadPersistedAuthProfileStoreFromRows(rows, databasePath),
      });
    };
    const loadPrepared = async () => {
      if (selectedAgentPath) {
        await readOwner(effectiveAgentDir, selectedAgentPath, agentReads.get(selectedAgentPath)!);
      }
      if (needsSharedStore && sharedPreparationFailure) {
        throw sharedPreparationFailure.error;
      }
      const sharedOwnership = needsSharedStore
        ? await resolveSharedAuthStoreOwnershipAsync(sharedContext!)
        : undefined;
      const sharedPath = sharedOwnership ? resolveSharedAuthPath(env) : undefined;
      const requestedPath = selectedAgentPath ?? sharedPath!;
      const inheritedPath = inheritedAuthDir ? resolveAgentAuthPath(inheritedAuthDir) : sharedPath!;
      inheritedObservationPath = inheritedPath;
      const paths = [...new Set([requestedPath, ...(effectiveAgentDir ? [inheritedPath] : [])])];
      for (const databasePath of paths) {
        if (stores.has(databasePath)) {
          continue;
        }
        try {
          await readOwner(
            databasePath === requestedPath ? effectiveAgentDir : inheritedAuthDir,
            databasePath,
            databasePath === sharedPath && sharedOwnership?.location === "state-db"
              ? {
                  read: () => readSharedAuthProfileRows(sharedContext!),
                  assertCurrent: () => sharedContext!.admission.assertCurrent(),
                }
              : agentReads.get(databasePath)!,
          );
        } catch (error) {
          if (databasePath === requestedPath) {
            throw error;
          }
          // Composition applies the current inherited-owner refusal policy to this read's failure.
          stores.set(databasePath, { ok: false, error });
        }
      }
      const assertCurrent = () => {
        sharedContext?.admission.assertCurrent();
        for (const databasePath of paths) {
          rowReaders.get(databasePath)?.assertCurrent();
          const owner = readOwners.get(databasePath);
          // A later owner read can yield after these fixed legacy paths were checked.
          assertAuthProfileMigrationCandidates({
            databasePath,
            candidates: owner?.candidates ?? [],
            hasCredentials: () => Object.keys(owner?.readStore()?.profiles ?? {}).length > 0,
            provider: capturedOptions.migrationProvider,
            config: capturedOptions.config,
            deferScopedRefusals: capturedOptions.deferScopedMigrationRefusals,
          });
        }
      };
      assertCurrent();
      const load = () =>
        loadRuntimeAuthProfileStore(
          effectiveAgentDir,
          { ...capturedOptions, profileId: undefined },
          env,
          (databasePath) => {
            const prepared = stores.get(databasePath);
            if (!prepared) {
              throw new Error("Auth profile read changed its prepared database owner");
            }
            if (!prepared.ok) {
              throw prepared.error;
            }
            return prepared.value;
          },
        );
      const store = inCapturedScope(load);
      if (!personalProfileId) {
        return { store, assertCurrent };
      }
      if (sharedPreparationFailure) {
        throw sharedPreparationFailure.error;
      }
      const personalProfile = await readUserModelAuthProfileAsync(
        personalProfileId,
        sharedContext!,
      );
      assertCurrent();
      return {
        store: materializePreparedPersonalAuthProfile(store, personalProfileId, personalProfile),
        assertCurrent,
      };
    };
    let result: Result<{ store: AuthProfileStore; assertCurrent: () => void }, unknown>;
    try {
      result = { ok: true, value: await loadPrepared() };
    } catch (error) {
      result = { ok: false, error };
    }
    const cleanup = await Promise.allSettled(
      [...agentReads.values()].map((reader) => reader.dispose()),
    );
    const failures = cleanup.flatMap((entry) =>
      entry.status === "rejected" ? [entry.reason] : [],
    );
    if (failures.length > 0) {
      const error =
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Auth profile reader cleanup failed", {
              cause: failures[0],
            });
      throw result.ok
        ? error
        : withSqliteWorkerCleanupFailure(
            toErrorObject(result.error, "Auth profile runtime read failed"),
            error,
          );
    }
    if (!result.ok) {
      throw result.error;
    }
    result.value.assertCurrent();
    return result.value.store;
  }

  return { loadAuthProfileStoreForRuntime, loadAuthProfileStoreForRuntimeAsync };
}
