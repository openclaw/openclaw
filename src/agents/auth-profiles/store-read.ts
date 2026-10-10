/** Shared auth-store read policy with synchronous and captured-worker adapters. */
import { isDeepStrictEqual } from "node:util";
import type { Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { cloneAuthProfileStore } from "./clone.js";
import type { createExternalAuthRuntime, ExternalCliOverlayOptions } from "./external-auth.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import {
  loadInheritedAuthProfileStore,
  readRuntimeAuthProfileStoreFromSnapshots,
} from "./inherited-store.js";
import { resolveSharedAuthStorePath as resolveSharedAuthPath } from "./path-resolve.js";
import { mergeAuthProfileStores } from "./persisted.js";
import { materializePersonalAuthProfile } from "./personal-profiles.js";
import { mergeRuntimeExternalProfileReferences } from "./runtime-external-profile-references.js";
import {
  resolveExternalCliOverlayOptions,
  type createAuthProfileStoreRuntimeReader,
  type LoadAuthProfileStoreOptions,
} from "./runtime-read.js";
import {
  createEmptyAuthProfileStore,
  listRuntimeLocalProfileIds,
  mergeLocalAuthProfileStoreWithInheritedStore,
  pruneAuthProfileStoreReferences,
  setRuntimeLocalProfileMetadata,
  stripRuntimeExternalProfileMetadata,
} from "./runtime-snapshot-owner.js";
import {
  getPreparedRuntimeAuthProfileStoreSnapshotCore,
  type setRuntimeAuthProfileStoreSnapshot as SetRuntimeAuthProfileStoreSnapshot,
  type updateRuntimeAuthProfileStoreSnapshot as UpdateRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import {
  resolveAuthProfileDatabasePath as resolveAgentAuthPath,
  type AuthProfileDatabase,
} from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

type RuntimeReadHost = Parameters<typeof createAuthProfileStoreRuntimeReader>[0];
type StoreReadHost = Pick<
  RuntimeReadHost,
  | "isEnvOnlyAuthProfileRuntime"
  | "getScopedAuthProfileEnv"
  | "resolveRuntimeAuthProfileAgentDir"
  | "resolveRuntimeAuthProfileLoadOptions"
  | "loadAuthProfileStoreForAgent"
  | "captureScope"
> & {
  getScopedSharedAuthStore: () => AuthProfileStore | undefined;
  resolvePersistedLoadOptions: (
    options: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt" | "database"> | undefined,
  ) => { allowKeychainPrompt?: boolean; database?: AuthProfileDatabase };
  withPreparedAuthProfileStoreReads: ReturnType<
    typeof createAuthProfileStoreRuntimeReader
  >["withPreparedAuthProfileStoreReads"];
  overlayExternalAuthProfiles: ReturnType<
    typeof createExternalAuthRuntime
  >["overlayExternalAuthProfiles"];
  setRuntimeAuthProfileStoreSnapshot: typeof SetRuntimeAuthProfileStoreSnapshot;
  updateRuntimeAuthProfileStoreSnapshot: typeof UpdateRuntimeAuthProfileStoreSnapshot;
};

function hasScopedExternalCliOverlay(options: ExternalCliOverlayOptions): boolean {
  return (
    options.externalCliProviderIds !== undefined || options.externalCliProfileIds !== undefined
  );
}

type AuthProfileStoreReadRequest =
  | { kind: "store"; agentDir?: string; options?: LoadAuthProfileStoreOptions }
  | { kind: "shared-path" };
type AuthProfileStoreReadValue =
  | { kind: "store"; store: AuthProfileStore }
  | { kind: "shared-path"; path: string };
type AuthProfileStoreReadSequence<T = AuthProfileStore> = Generator<
  AuthProfileStoreReadRequest,
  T,
  Result<AuthProfileStoreReadValue, unknown>
>;

function* readAuthProfileStore(
  request: Omit<Extract<AuthProfileStoreReadRequest, { kind: "store" }>, "kind">,
): AuthProfileStoreReadSequence {
  const result = yield { kind: "store", ...request };
  if (!result.ok) {
    throw result.error;
  }
  if (result.value.kind !== "store") {
    throw new Error("Auth profile read returned a different requested fact");
  }
  return result.value.store;
}

function* readSharedAuthPath(): AuthProfileStoreReadSequence<string> {
  const result = yield { kind: "shared-path" };
  if (!result.ok) {
    throw result.error;
  }
  if (result.value.kind !== "shared-path") {
    throw new Error("Auth profile owner read returned a different requested fact");
  }
  return result.value.path;
}

export function createAuthProfileStoreReadRuntime(host: StoreReadHost) {
  const {
    isEnvOnlyAuthProfileRuntime,
    getScopedAuthProfileEnv,
    getScopedSharedAuthStore,
    resolveRuntimeAuthProfileAgentDir,
    resolveRuntimeAuthProfileLoadOptions,
    resolvePersistedLoadOptions,
    loadAuthProfileStoreForAgent,
    captureScope,
    withPreparedAuthProfileStoreReads,
    overlayExternalAuthProfiles,
    setRuntimeAuthProfileStoreSnapshot,
    updateRuntimeAuthProfileStoreSnapshot,
  } = host;

  function readAuthProfileStoreSynchronously(
    createReads: (options?: LoadAuthProfileStoreOptions) => AuthProfileStoreReadSequence,
    options?: LoadAuthProfileStoreOptions,
  ): AuthProfileStore {
    const profileId =
      options?.profileId && isUserModelAuthProfileId(options.profileId)
        ? options.profileId
        : undefined;
    const reads = createReads(profileId ? { ...options, profileId: undefined } : options);
    let step = reads.next();
    while (!step.done) {
      let result: Result<AuthProfileStoreReadValue, unknown>;
      try {
        result = {
          ok: true,
          value:
            step.value.kind === "shared-path"
              ? { kind: "shared-path", path: resolveSharedAuthPath(getScopedAuthProfileEnv()) }
              : {
                  kind: "store",
                  store: loadAuthProfileStoreForAgent(step.value.agentDir, step.value.options),
                },
        };
      } catch (error) {
        result = { ok: false, error };
      }
      step = reads.next(result);
    }
    return profileId && !captureScope().isolated
      ? materializePersonalAuthProfile(step.value, profileId)
      : step.value;
  }

  function* readInheritedAuthProfileStore(
    options: LoadAuthProfileStoreOptions,
    env?: NodeJS.ProcessEnv,
  ): AuthProfileStoreReadSequence<AuthProfileStore | undefined> {
    try {
      return yield* readAuthProfileStore({ agentDir: options.inheritedAuthDir, options });
    } catch (error) {
      return loadInheritedAuthProfileStore(
        () => {
          throw error;
        },
        options.inheritedAuthDir,
        env ?? getScopedAuthProfileEnv(),
      );
    }
  }

  function* resolveRuntimeAuthProfileStore(
    agentDir?: string,
    options?: Pick<
      LoadAuthProfileStoreOptions,
      "allowKeychainPrompt" | "inheritedAuthDir" | "migrationProvider" | "config"
    >,
    env?: NodeJS.ProcessEnv,
  ): AuthProfileStoreReadSequence<AuthProfileStore | null> {
    // Ambient snapshots may include non-portable shared profiles. A bounded exec
    // scope composes its view from the actual local store and its filtered base.
    if (getScopedSharedAuthStore()) {
      return null;
    }
    const sharedPath =
      !agentDir || !options?.inheritedAuthDir ? yield* readSharedAuthPath() : undefined;
    const reads = readRuntimeAuthProfileStoreFromSnapshots({
      agentDir,
      inheritedAuthDir: options?.inheritedAuthDir,
      env: env ?? getScopedAuthProfileEnv(),
      sharedPath,
    });
    let step = reads.next();
    while (!step.done) {
      let result: Result<AuthProfileStore, unknown>;
      try {
        result = {
          ok: true,
          value: yield* readAuthProfileStore({
            agentDir: step.value.agentDir,
            options: {
              migrationProvider: options?.migrationProvider,
              config: options?.config,
              readOnly: true,
              syncExternalCli: false,
              ...resolvePersistedLoadOptions(options),
            },
          }),
        };
      } catch (error) {
        result = { ok: false, error };
      }
      step = reads.next(result);
    }
    return step.value;
  }

  function* buildAuthProfileStoreWithoutExternalProfiles(params: {
    store: AuthProfileStore;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    options?: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt" | "inheritedAuthDir">;
  }): AuthProfileStoreReadSequence {
    const runtimeExternalProfileIds = new Set(params.store.runtimeExternalProfileIds ?? []);
    const localStore = cloneAuthProfileStore(params.store);
    if (runtimeExternalProfileIds.size === 0) {
      return stripRuntimeExternalProfileMetadata(localStore);
    }
    for (const profileId of runtimeExternalProfileIds) {
      delete localStore.profiles[profileId];
    }
    const keptProfileIds = new Set(Object.keys(localStore.profiles));
    pruneAuthProfileStoreReferences(localStore, keptProfileIds);
    const persistedStore = yield* loadAuthProfileStoreWithoutExternalProfilesReads(
      params.agentDir,
      params.options,
      params.env,
    );
    return stripRuntimeExternalProfileMetadata(mergeAuthProfileStores(persistedStore, localStore));
  }

  /** Load auth profiles with runtime external profiles removed from the result. */
  function loadAuthProfileStoreWithoutExternalProfiles(
    agentDir?: string,
    loadOptions?: Pick<
      LoadAuthProfileStoreOptions,
      "allowKeychainPrompt" | "inheritedAuthDir" | "profileId"
    >,
  ): AuthProfileStore {
    return readAuthProfileStoreSynchronously(
      (options) => loadAuthProfileStoreWithoutExternalProfilesReads(agentDir, options),
      loadOptions,
    );
  }

  function* loadAuthProfileStoreWithoutExternalProfilesReads(
    agentDir?: string,
    loadOptions?: Parameters<typeof loadAuthProfileStoreWithoutExternalProfiles>[1],
    env?: NodeJS.ProcessEnv,
  ): AuthProfileStoreReadSequence {
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const effectiveLoadOptions = resolveRuntimeAuthProfileLoadOptions(loadOptions);
    const options: LoadAuthProfileStoreOptions = {
      readOnly: true,
      allowKeychainPrompt: effectiveLoadOptions?.allowKeychainPrompt ?? false,
      ...(effectiveLoadOptions?.inheritedAuthDir
        ? { inheritedAuthDir: effectiveLoadOptions.inheritedAuthDir }
        : {}),
    };
    return yield* readAuthProfileStoreFromSources(effectiveAgentDir, options, env, true);
  }

  /** Ensure an auth store is available, including runtime/external profile overlays. */
  function ensureAuthProfileStore(
    agentDir?: string,
    options?: {
      migrationProvider?: string;
      profileId?: string;
      allowKeychainPrompt?: boolean;
      config?: OpenClawConfig;
      externalCli?: ExternalCliAuthDiscovery;
      externalCliProviderIds?: Iterable<string>;
      externalCliProfileIds?: Iterable<string>;
      inheritedAuthDir?: string;
      readOnly?: boolean;
      syncExternalCli?: boolean;
    },
  ): AuthProfileStore {
    return readAuthProfileStoreSynchronously(
      (readOptions) => ensureAuthProfileStoreReads(agentDir, readOptions),
      options,
    );
  }

  function* ensureAuthProfileStoreReads(
    agentDir?: string,
    options?: Parameters<typeof ensureAuthProfileStore>[1],
    env?: NodeJS.ProcessEnv,
  ): AuthProfileStoreReadSequence {
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const effectiveOptions = resolveRuntimeAuthProfileLoadOptions(options);
    const externalCli = resolveExternalCliOverlayOptions(effectiveOptions);
    const runtimeStore = yield* resolveRuntimeAuthProfileStore(
      effectiveAgentDir,
      effectiveOptions,
      env,
    );
    const store = overlayExternalAuthProfiles(
      yield* ensureAuthProfileStoreWithoutExternalProfilesReads(
        effectiveAgentDir,
        effectiveOptions,
        env,
      ),
      {
        agentDir: effectiveAgentDir,
        ...(env ? { env } : {}),
        ...externalCli,
      },
    );
    if (!runtimeStore) {
      if (
        !getScopedSharedAuthStore() &&
        hasScopedExternalCliOverlay(externalCli) &&
        (store.runtimeExternalProfileIds?.length ?? 0) > 0
      ) {
        setRuntimeAuthProfileStoreSnapshot(store, effectiveAgentDir);
      }
      return store;
    }
    const materialized = mergeRuntimeExternalProfileReferences({
      next: store,
      existing: runtimeStore,
      externalRefresh: true,
    });
    if (hasScopedExternalCliOverlay(externalCli)) {
      // Scoped turn/control-plane resolution returns only the requested overlay, but the lifecycle
      // snapshot must retain unrelated external profiles. Publish the merged owner fact so prepared
      // model and chat metadata generations converge without reopening credential sources.
      if (!isDeepStrictEqual(materialized, runtimeStore)) {
        updateRuntimeAuthProfileStoreSnapshot(materialized, effectiveAgentDir);
      }
      return store;
    }
    return materialized;
  }

  /** Ensure an auth store is available without external profile overlays. */
  function ensureAuthProfileStoreWithoutExternalProfiles(
    agentDir?: string,
    options?: {
      migrationProvider?: string;
      config?: OpenClawConfig;
      profileId?: string;
      allowKeychainPrompt?: boolean;
      inheritedAuthDir?: string;
      readOnly?: boolean;
      syncExternalCli?: boolean;
    },
  ): AuthProfileStore {
    return readAuthProfileStoreSynchronously(
      (readOptions) => ensureAuthProfileStoreWithoutExternalProfilesReads(agentDir, readOptions),
      options,
    );
  }

  function* ensureAuthProfileStoreWithoutExternalProfilesReads(
    agentDir?: string,
    options?: Parameters<typeof ensureAuthProfileStoreWithoutExternalProfiles>[1],
    env?: NodeJS.ProcessEnv,
  ): AuthProfileStoreReadSequence {
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const effectiveOptions: LoadAuthProfileStoreOptions = resolveRuntimeAuthProfileLoadOptions(
      options,
    ) ?? { ...options };
    const runtimeStore = yield* resolveRuntimeAuthProfileStore(
      effectiveAgentDir,
      effectiveOptions,
      env,
    );
    if (runtimeStore) {
      return yield* buildAuthProfileStoreWithoutExternalProfiles({
        store: runtimeStore,
        agentDir: effectiveAgentDir,
        options: effectiveOptions,
        env,
      });
    }
    return yield* readAuthProfileStoreFromSources(effectiveAgentDir, effectiveOptions, env, false);
  }

  function* readAuthProfileStoreFromSources(
    agentDir: string | undefined,
    options: LoadAuthProfileStoreOptions,
    env: NodeJS.ProcessEnv | undefined,
    includeLocalMetadata: boolean,
  ): AuthProfileStoreReadSequence {
    const store = yield* readAuthProfileStore({ agentDir, options });
    const authPath = agentDir ? resolveAgentAuthPath(agentDir) : yield* readSharedAuthPath();
    const mainAuthPath = options.inheritedAuthDir
      ? resolveAgentAuthPath(options.inheritedAuthDir)
      : yield* readSharedAuthPath();
    if (!agentDir || authPath === mainAuthPath) {
      const stripped = stripRuntimeExternalProfileMetadata(store);
      return includeLocalMetadata
        ? setRuntimeLocalProfileMetadata(stripped, listRuntimeLocalProfileIds(store))
        : stripped;
    }
    const mainStore = yield* readInheritedAuthProfileStore(options, env);
    return includeLocalMetadata
      ? mergeLocalAuthProfileStoreWithInheritedStore(store, mainStore)
      : stripRuntimeExternalProfileMetadata(
          mainStore
            ? mergeAuthProfileStores(mainStore, store, {
                preserveBaseRuntimeExternalProfiles: true,
              })
            : store,
        );
  }

  function* readAuthProfileStoreForModelRuntime(
    agentDir: string,
    options: { config: OpenClawConfig; inheritedAuthDir?: string; skipCredentials?: boolean },
    env: NodeJS.ProcessEnv,
  ): AuthProfileStoreReadSequence<AuthProfileStore | undefined> {
    // The shared-owner decision is itself a captured read, before selecting published facts.
    if (!options.inheritedAuthDir) {
      yield* readSharedAuthPath();
    }
    const published = getPreparedRuntimeAuthProfileStoreSnapshotCore(
      agentDir,
      options.inheritedAuthDir,
      env,
    );
    const hasPublishedExternalProfiles =
      published !== undefined &&
      (published.runtimeExternalProfileIds !== undefined ||
        published.runtimeExternalProfileIdsAuthoritative === true);
    const readOptions = {
      allowKeychainPrompt: false,
      readOnly: true,
      ...(options.inheritedAuthDir ? { inheritedAuthDir: options.inheritedAuthDir } : {}),
    };
    if (hasPublishedExternalProfiles) {
      const durable = yield* ensureAuthProfileStoreWithoutExternalProfilesReads(
        agentDir,
        readOptions,
        env,
      );
      return mergeAuthProfileStores(durable, published);
    }
    if (options.skipCredentials) {
      return undefined;
    }
    return yield* ensureAuthProfileStoreReads(
      agentDir,
      { ...readOptions, config: options.config },
      env,
    );
  }

  async function prepareAuthProfileStoreForModelRuntime(
    agentDir: string,
    options: { config: OpenClawConfig; inheritedAuthDir?: string; skipCredentials?: boolean },
    assertCurrent: () => void,
    env?: NodeJS.ProcessEnv,
  ): Promise<AuthProfileStore | undefined> {
    assertCurrent();
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    return withPreparedAuthProfileStoreReads(
      agentDir,
      {
        config: options.config,
        inheritedAuthDir: options.inheritedAuthDir,
        readOnly: true,
        allowKeychainPrompt: false,
      },
      async (prepared) => {
        const reads = readAuthProfileStoreForModelRuntime(
          prepared.effectiveAgentDir ?? agentDir,
          { ...options, inheritedAuthDir: prepared.options.inheritedAuthDir },
          prepared.env,
        );
        const advance = (result?: Result<AuthProfileStoreReadValue, unknown>) => {
          assertCurrent();
          prepared.assertCurrent();
          return prepared.runInCapturedScope(() =>
            result === undefined ? reads.next() : reads.next(result),
          );
        };
        let step = advance();
        while (!step.done) {
          let result: Result<AuthProfileStoreReadValue, unknown>;
          try {
            result = {
              ok: true,
              value:
                step.value.kind === "shared-path"
                  ? { kind: "shared-path", path: await prepared.sharedPath() }
                  : {
                      kind: "store",
                      store: await prepared.readStore(
                        step.value.agentDir,
                        step.value.options ?? {},
                      ),
                    },
            };
          } catch (error) {
            result = { ok: false, error };
          }
          step = advance(result);
        }
        return step.value;
      },
      env,
    );
  }

  return {
    loadAuthProfileStoreWithoutExternalProfiles,
    ensureAuthProfileStore,
    ensureAuthProfileStoreWithoutExternalProfiles,
    prepareAuthProfileStoreForModelRuntime,
  };
}
