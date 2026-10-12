/** Runtime auth reads compose worker-prepared facts through the store's captured host scope. */
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  getActiveOpenClawStateDatabaseReadSnapshot,
  isArtifactPreservingStateRead,
} from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import type { ExternalCliOverlayOptions } from "./external-auth.js";
import {
  assertAuthProfileMigrationCandidates,
  assertAuthProfileMigrationStateAtDatabasePath,
} from "./legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "./legacy-source-files.js";
import {
  resolveSharedAuthStoreOwnershipAsync,
  resolveSharedAuthStorePath as resolveSharedAuthPath,
} from "./path-resolve.js";
import { materializePreparedPersonalAuthProfile } from "./personal-profiles.js";
import type {
  AuthProfileReadOwner,
  LoadAuthProfileStoreOptions,
  PreparedAuthProfileStoreReads,
} from "./runtime-read.types.js";
import { readAuthProfileStoreInWorker } from "./runtime-read.worker.js";
import { getWorkerAuthProfileWrites } from "./runtime-scope.js";
import { createEmptyAuthProfileStore } from "./runtime-snapshot-owner.js";
import { runtimeAuthProfileRowsCache } from "./runtime-snapshots.js";
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
} from "./sqlite.js";
import type { AuthProfileStore, AuthProfileRowRead } from "./types.js";

export type {
  AuthProfileReadOwner,
  LoadAuthProfileStoreOptions,
  PreparedAuthProfileStoreReads,
} from "./runtime-read.types.js";

export function resolveExternalCliOverlayOptions(
  options: LoadAuthProfileStoreOptions | undefined,
): ExternalCliOverlayOptions {
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
  loadRuntimeAuthProfileStore: (
    agentDir?: string,
    options?: LoadAuthProfileStoreOptions,
    env?: NodeJS.ProcessEnv,
    readPreparedStore?: (databasePath: string) => AuthProfileStore,
  ) => AuthProfileStore;
  captureScope: () => {
    isolated: boolean;
    run: <T>(agentDir: string | undefined, env: NodeJS.ProcessEnv, run: () => T) => T;
  };
};

type AsyncAuthProfileStoreOptions = Omit<
  LoadAuthProfileStoreOptions,
  "database" | "onReadOwner" | "syncExternalCli"
>;

type AuthProfileRowsReader = Pick<
  ReturnType<typeof prepareAgentAuthProfileRowsRead>,
  "read" | "assertCurrent"
>;

function captureReadOptions(
  options: LoadAuthProfileStoreOptions | undefined,
): LoadAuthProfileStoreOptions {
  const discovery = options?.externalCli;
  return {
    ...options,
    readOnly: true,
    externalCli:
      discovery?.mode === "scoped"
        ? {
            ...discovery,
            ...(discovery.providerIds ? { providerIds: [...discovery.providerIds] } : {}),
            ...(discovery.profileIds ? { profileIds: [...discovery.profileIds] } : {}),
          }
        : discovery,
    ...(options?.externalCliProviderIds
      ? { externalCliProviderIds: [...options.externalCliProviderIds] }
      : {}),
    ...(options?.externalCliProfileIds
      ? { externalCliProfileIds: [...options.externalCliProfileIds] }
      : {}),
  };
}

/** Bind to the canonical store scope; this reader owns no mutable runtime or lifecycle state. */
export function createAuthProfileStoreRuntimeReader({
  isEnvOnlyAuthProfileRuntime,
  getScopedAuthProfileEnv,
  resolveRuntimeAuthProfileAgentDir,
  resolveRuntimeAuthProfileLoadOptions,
  loadAuthProfileStoreForAgent,
  loadRuntimeAuthProfileStore,
  captureScope,
}: RuntimeReadHost) {
  /** Capture sources once; the store owner decides which persisted facts it needs. */
  function withPreparedAuthProfileStoreReads(
    agentDir: string | undefined,
    options: AsyncAuthProfileStoreOptions | undefined,
    consume?: undefined,
    suppliedEnv?: NodeJS.ProcessEnv,
  ): Promise<AuthProfileStore>;
  function withPreparedAuthProfileStoreReads<T>(
    agentDir: string | undefined,
    options: AsyncAuthProfileStoreOptions | undefined,
    consume: (reads: PreparedAuthProfileStoreReads) => Promise<T>,
    suppliedEnv?: NodeJS.ProcessEnv,
  ): Promise<T>;
  async function withPreparedAuthProfileStoreReads<T>(
    agentDir: string | undefined,
    options: AsyncAuthProfileStoreOptions | undefined,
    consume?: (reads: PreparedAuthProfileStoreReads) => Promise<T>,
    suppliedEnv?: NodeJS.ProcessEnv,
  ): Promise<T | AuthProfileStore> {
    const scope = captureScope();
    const env = cloneEnvWithPlatformSemantics(
      getScopedAuthProfileEnv() ?? suppliedEnv ?? process.env,
    );
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
    const capturedOptions = captureReadOptions({
      ...scopedOptions,
      inheritedAuthDir,
    });
    const worker = getWorkerAuthProfileWrites();
    if (worker) {
      return readAuthProfileStoreInWorker(
        {
          worker,
          env,
          effectiveAgentDir,
          options: capturedOptions,
          scope,
          loadAuthProfileStoreForAgent,
          loadRuntimeAuthProfileStore,
        },
        consume,
      );
    }
    const profileId = capturedOptions.profileId;
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
    const inCapturedScope = <Value>(run: () => Value): Value =>
      scope.run(effectiveAgentDir, env, run);
    const rowsByPath = new Map<string, AuthProfileRowRead>();
    const stores = new Map<string, Result<AuthProfileStore, unknown>>();
    let active = true;
    let accepting = true;
    const assertAccepting = () => {
      if (!accepting) {
        throw new Error("Auth profile read scope is no longer accepting reads");
      }
    };
    let sharedContextUsed = false;
    const readOwners: Array<{
      databasePath: string;
      options: LoadAuthProfileStoreOptions;
      owner?: AuthProfileReadOwner;
    }> = [];
    const rowReaders = new Map<string, AuthProfileRowsReader>();
    const readOwner = async (
      ownerAgentDir: string | undefined,
      databasePath: string,
      reader: AuthProfileRowsReader,
      requestOptions: LoadAuthProfileStoreOptions,
    ) => {
      const demand: (typeof readOwners)[number] = { databasePath, options: requestOptions };
      readOwners.push(demand);
      assertAuthProfileMigrationStateAtDatabasePath(
        databasePath,
        requestOptions.migrationProvider,
        requestOptions.config,
        requestOptions.deferScopedMigrationRefusals,
      );
      const candidates = resolveLegacyAuthProfileSourceCandidates({ agentDir: ownerAgentDir, env });
      const preparedReader =
        rowReaders.get(databasePath) ??
        (reusePersistedRows ? runtimeAuthProfileRowsCache.prepare(databasePath, reader) : reader);
      rowReaders.set(databasePath, preparedReader);
      const rows = rowsByPath.get(databasePath) ?? (await preparedReader.read());
      preparedReader.assertCurrent();
      rowsByPath.set(databasePath, rows);
      const store = inCapturedScope(() =>
        loadAuthProfileStoreForAgent(ownerAgentDir, requestOptions, env, rows),
      );
      demand.owner = {
        databasePath,
        candidates,
        readStore: () => loadPersistedAuthProfileStoreFromRows(rows, databasePath),
      };
      stores.set(databasePath, { ok: true, value: store });
      return store;
    };
    const assertCurrent = () => {
      if (!active) {
        throw new Error("Auth profile read scope is no longer active");
      }
      if (sharedContextUsed) {
        sharedContext?.maintenanceScope?.assertAdmission();
        sharedContext?.admission.assertCurrent();
      }
      for (const reader of rowReaders.values()) {
        reader.assertCurrent();
      }
      for (const demand of readOwners) {
        assertAuthProfileMigrationCandidates({
          databasePath: demand.databasePath,
          candidates: demand.owner?.candidates ?? [],
          hasCredentials: () => Object.keys(demand.owner?.readStore()?.profiles ?? {}).length > 0,
          provider: demand.options.migrationProvider,
          config: demand.options.config,
          deferScopedRefusals: demand.options.deferScopedMigrationRefusals,
        });
      }
    };
    const sharedPath = async () => {
      assertAccepting();
      if (sharedPreparationFailure) {
        throw sharedPreparationFailure.error;
      }
      if (!sharedContext || !needsSharedStore) {
        throw new Error("Auth profile read requested an uncaptured shared owner");
      }
      sharedContextUsed = true;
      sharedContext.maintenanceScope?.assertAdmission();
      sharedContext.admission.assertCurrent();
      await resolveSharedAuthStoreOwnershipAsync(sharedContext);
      assertAccepting();
      sharedContext.maintenanceScope?.assertAdmission();
      sharedContext.admission.assertCurrent();
      return resolveSharedAuthPath(env);
    };
    const readStore: PreparedAuthProfileStoreReads["readStore"] = async (
      ownerAgentDir,
      requestOptions,
    ) => {
      assertAccepting();
      assertCurrent();
      const resolvedDir = inCapturedScope(() => resolveRuntimeAuthProfileAgentDir(ownerAgentDir));
      const directory = resolvedDir ? path.dirname(resolveAgentAuthPath(resolvedDir)) : undefined;
      const scopedRequest = inCapturedScope(() =>
        resolveRuntimeAuthProfileLoadOptions(requestOptions),
      );
      const requestedOptions = captureReadOptions(scopedRequest);
      let databasePath: string;
      let reader: AuthProfileRowsReader | undefined;
      if (directory) {
        databasePath = resolveAgentAuthPath(directory);
        reader = agentReads.get(databasePath);
      } else {
        databasePath = await sharedPath();
        const context = sharedContext!;
        reader =
          databasePath === context.admission.databasePath
            ? {
                read: () => readSharedAuthProfileRows(context),
                assertCurrent: () => context.admission.assertCurrent(),
              }
            : agentReads.get(databasePath);
      }
      if (!reader) {
        throw new Error("Auth profile read requested an uncaptured database owner");
      }
      assertAccepting();
      const store = await readOwner(directory, databasePath, reader, requestedOptions);
      assertAccepting();
      assertCurrent();
      return store;
    };
    const materializePersonalProfile = async (store: AuthProfileStore) => {
      if (!personalProfileId) {
        return store;
      }
      if (sharedPreparationFailure) {
        throw sharedPreparationFailure.error;
      }
      const personalProfile = await readUserModelAuthProfileAsync(
        personalProfileId,
        sharedContext!,
      );
      assertCurrent();
      return materializePreparedPersonalAuthProfile(store, personalProfileId, personalProfile);
    };
    const loadPrepared = async () => {
      if (selectedAgentPath) {
        await readOwner(
          effectiveAgentDir,
          selectedAgentPath,
          agentReads.get(selectedAgentPath)!,
          capturedOptions,
        );
      }
      if (needsSharedStore && sharedPreparationFailure) {
        throw sharedPreparationFailure.error;
      }
      const sharedOwnership = needsSharedStore
        ? await resolveSharedAuthStoreOwnershipAsync(sharedContext!)
        : undefined;
      sharedContextUsed = needsSharedStore || personalProfileId !== undefined;
      const selectedSharedPath = sharedOwnership ? resolveSharedAuthPath(env) : undefined;
      const requestedPath = selectedAgentPath ?? selectedSharedPath!;
      const inheritedPath = inheritedAuthDir
        ? resolveAgentAuthPath(inheritedAuthDir)
        : selectedSharedPath!;
      const paths = [...new Set([requestedPath, ...(effectiveAgentDir ? [inheritedPath] : [])])];
      for (const databasePath of paths) {
        if (stores.has(databasePath)) {
          continue;
        }
        try {
          await readOwner(
            databasePath === requestedPath ? effectiveAgentDir : inheritedAuthDir,
            databasePath,
            databasePath === selectedSharedPath && sharedOwnership?.location === "state-db"
              ? {
                  read: () => readSharedAuthProfileRows(sharedContext!),
                  assertCurrent: () => sharedContext!.admission.assertCurrent(),
                }
              : agentReads.get(databasePath)!,
            capturedOptions,
          );
        } catch (error) {
          if (databasePath === requestedPath) {
            throw error;
          }
          // Composition applies the current inherited-owner refusal policy to this read's failure.
          stores.set(databasePath, { ok: false, error });
        }
      }
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
      return materializePersonalProfile(store);
    };
    let result: Result<T | AuthProfileStore, unknown>;
    try {
      result = {
        ok: true,
        value: await (consume
          ? consume({
              effectiveAgentDir,
              env,
              options: capturedOptions,
              sharedPath,
              runInCapturedScope: (operation) => {
                if (!accepting) {
                  throw new Error("Auth profile read scope is no longer active");
                }
                return inCapturedScope(operation);
              },
              readStore,
              assertCurrent,
              materializePersonalProfile,
            })
          : loadPrepared()),
      };
    } catch (error) {
      result = { ok: false, error };
    } finally {
      accepting = false;
    }
    const cleanup = await Promise.allSettled(
      [...agentReads.values()].map((reader) => reader.dispose()),
    );
    const failures = cleanup.flatMap((entry) =>
      entry.status === "rejected" ? [entry.reason] : [],
    );
    try {
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
      assertCurrent();
      return result.value;
    } finally {
      active = false;
    }
  }

  /** Read persisted facts off-thread; scoped overlays and live setup selection stay on the host. */
  async function loadAuthProfileStoreForRuntimeAsync(
    agentDir?: string,
    options?: AsyncAuthProfileStoreOptions,
    env?: NodeJS.ProcessEnv,
  ): Promise<AuthProfileStore> {
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    return withPreparedAuthProfileStoreReads(agentDir, options, undefined, env);
  }

  /** @deprecated Use loadAuthProfileStoreForRuntimeAsync. Removed at the next Plugin SDK major. */
  function loadAuthProfileStoreForRuntime(
    agentDir?: string,
    options?: LoadAuthProfileStoreOptions,
    env?: NodeJS.ProcessEnv,
  ): AuthProfileStore {
    warnPluginSdkDeprecation({
      family: "auth-profiles",
      method: "loadAuthProfileStoreForRuntime",
      replacement: "loadAuthProfileStoreForRuntimeAsync",
    });
    return loadRuntimeAuthProfileStore(agentDir, options, env);
  }

  return {
    loadAuthProfileStoreForRuntime,
    loadAuthProfileStoreForRuntimeAsync,
    withPreparedAuthProfileStoreReads,
  };
}
