/**
 * Auth profile store orchestration.
 * Merges persisted stores, runtime snapshots, inherited main-agent OAuth
 * profiles, and external CLI overlays while keeping save paths local.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { projectModelProviderConfig } from "../../config/model-provider-config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { readUserModelAuthProfile } from "../../state/user-model-accounts.js";
import { isRecord, resolveUserPath } from "../../utils.js";
import { areAuthProfileStoresEqual, cloneAuthProfileStore } from "./clone.js";
import { AUTH_STORE_VERSION, authProfilesLog } from "./constants.js";
import {
  syncPersistedExternalCliAuthProfiles,
  type createExternalAuthRuntime,
} from "./external-auth.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import {
  loadInheritedAuthProfileStore,
  resolveRuntimeAuthProfileStoreFromSnapshots,
} from "./inherited-store.js";
import {
  AuthProfileMigrationRequiredError,
  AuthProfileStoreUnreadableError,
  assertAuthProfileCredentialMigrationStateAtDatabasePath,
  assertAuthProfileMigrationCandidates,
  assertAuthProfileMigrationReady,
  assertAuthProfileMigrationStateAtDatabasePath,
  listLegacyAuthProfileSources,
  warnLegacyAuthProfileSourcesIgnored,
} from "./legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "./legacy-source-files.js";
import { captureOAuthRefreshClaimPublication } from "./oauth-refresh-marker.js";
import {
  shouldPersistRuntimeExternalOAuthProfile,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import {
  isInheritedMainOAuthCredentialFromStores,
  shouldUseMainOwnerForLocalOAuthCredential,
  type PersistedAuthProfileStores,
} from "./ownership.js";
import { resolveSharedAuthStorePath as resolveSharedAuthPath } from "./path-resolve.js";
import {
  buildPersistedAuthProfileSecretsStore,
  loadPersistedAuthProfileStore,
  loadPersistedAuthProfileStoreAtDatabasePath,
  loadPersistedSharedAuthProfileStore,
  mergeAuthProfileStores,
} from "./persisted.js";
import {
  materializePersonalAuthProfile,
  updatePersonalAuthProfileStore,
} from "./personal-profiles.js";
import {
  getRuntimeExternalCliProfileIds,
  mergeRuntimeExternalProfileReferences,
  removePersonalAuthProfileReferences,
  setRuntimeExternalCliProfileIds,
} from "./runtime-external-profile-references.js";
import {
  createAuthProfileStoreRuntimeReader,
  resolveExternalCliOverlayOptions,
  type AuthProfileReadOwner,
  type LoadAuthProfileStoreOptions,
  type ResolvedExternalCliOverlayOptions,
} from "./runtime-read.js";
import {
  captureRuntimeAuthProfileLegacyCandidates,
  pruneAuthProfileStoreReferences,
  preserveResolvedSecretBackedCredentials,
  createEmptyAuthProfileStore,
  listRuntimeLocalProfileIds,
  loadRuntimeAuthProfileOwnerSnapshot,
  markRuntimePersistedProfiles,
  mergeLocalAuthProfileStoreWithInheritedStore,
  runtimeAuthProfileSnapshotSharesOwner,
  runtimeStoreInheritsMainState,
  setRuntimeLocalProfileMetadata,
  stripRuntimeExternalProfileMetadata,
} from "./runtime-snapshot-owner.js";
import { publishPreparedRuntimeAuthProfileStoreSnapshot } from "./runtime-snapshot-publication.js";
import {
  clearRuntimeAuthProfileStoreSnapshotCore,
  clearRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  getPreparedRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  getRuntimeAuthProfileStoreSnapshotRevision,
  getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath,
  noteRuntimeAuthProfileStorePersistedMutation,
  listOwnedRuntimeAuthProfileStoreSnapshots,
  listRuntimeAuthProfileStoreSnapshotsForSharedOwner,
  restoreOwnedRuntimeAuthProfileStoreSnapshot,
  setRuntimeAuthProfileStoreSnapshot,
  updateRuntimeAuthProfileStoreSnapshot,
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
} from "./runtime-snapshots.js";
import { prepareScopedSharedAuthProfileStore } from "./shared-store-scope.js";
import { loadPersistedAuthProfileStoreFromRows } from "./sqlite-read.js";
import {
  deletePersistedAuthProfileStoreRaw,
  inspectPersistedAuthProfileStoreRaw,
  inspectPersistedSharedAuthProfileStoreRaw,
  readPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStateRaw,
  resolveAuthProfileDatabasePath as resolveAgentAuthPath,
  resolveAuthProfileStoreOwner,
  runAuthProfileWriteTransaction,
  runAuthProfileWriteTransactionAsync,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
  type AuthProfileDatabase,
  type AuthProfileStoreOwner,
  type PreparedAuthProfileStoreOwner,
} from "./sqlite.js";
import { loadPersistedAuthProfileState } from "./state.js";
import { prepareAuthProfileStoreMutation } from "./store-mutation.js";
import type {
  AuthProfileCredentialSource,
  AuthProfileStore,
  RuntimeAuthProfileStore,
} from "./types.js";

function withCredentialSources(
  store: AuthProfileStore,
  databasePath: string,
): RuntimeAuthProfileStore {
  return {
    ...store,
    runtimeCredentialSources: Object.fromEntries(
      Object.entries(store.profiles).map(([profileId, credential]) => [
        profileId,
        { databasePath, provider: credential.provider },
      ]),
    ),
  };
}

type SaveAuthProfileStoreOptions = {
  filterExternalAuthProfiles?: boolean;
  preserveOrderProfileIds?: Iterable<string>;
  preserveStateProfileIds?: Iterable<string>;
  pruneOrderProfileIds?: Iterable<string>;
  sharedStoreWrite?: boolean;
  syncExternalCli?: boolean;
};

type AuthProfileRuntimeMode =
  | { kind: "env-only" }
  | { kind: "agent-dir"; agentDir: string; sharedStore?: AuthProfileStore; env: NodeJS.ProcessEnv };

const authProfileRuntimeMode = new AsyncLocalStorage<AuthProfileRuntimeMode>();

/** Run a bounded operation without persisted or external CLI auth profiles. */
export function withEnvOnlyAuthProfileStore<T>(run: () => T): T {
  return authProfileRuntimeMode.run({ kind: "env-only" }, run);
}

/** Prepare shared credentials off-thread before entering a bounded persisted-auth operation. */
export async function withAuthProfileStoreAgentDir<T>(
  agentDir: string,
  sharedStateDir: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const env = { ...process.env, OPENCLAW_STATE_DIR: sharedStateDir };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolvedAgentDir = resolveUserPath(agentDir, env);
  const { sharedStore, assertCurrent } = await prepareScopedSharedAuthProfileStore(env);
  assertCurrent();
  return await authProfileRuntimeMode.run(
    { kind: "agent-dir", agentDir: resolvedAgentDir, sharedStore, env },
    run,
  );
}

export function getScopedAuthProfileEnv(): NodeJS.ProcessEnv | undefined {
  const mode = authProfileRuntimeMode.getStore();
  return mode?.kind === "agent-dir" ? mode.env : undefined;
}

export function getScopedSharedAuthStore(): AuthProfileStore | undefined {
  const mode = authProfileRuntimeMode.getStore();
  return mode?.kind === "agent-dir" ? mode.sharedStore : undefined;
}

export function applyScopedAuthReadThrough(store: AuthProfileStore): AuthProfileStore {
  const shared = getScopedSharedAuthStore();
  if (!shared) {
    return store;
  }
  const merged = mergeAuthProfileStores(cloneAuthProfileStore(shared), store);
  return setRuntimeLocalProfileMetadata(
    merged,
    Object.keys(store.profiles),
    runtimeStoreInheritsMainState(merged, store),
  );
}

function isEnvOnlyAuthProfileRuntime(): boolean {
  return authProfileRuntimeMode.getStore()?.kind === "env-only";
}

export function resolveRuntimeAuthProfileAgentDir(agentDir?: string): string | undefined {
  const mode = authProfileRuntimeMode.getStore();
  return mode?.kind === "agent-dir" ? mode.agentDir : agentDir;
}

function resolveRuntimeAuthProfileLoadOptions(
  options?: LoadAuthProfileStoreOptions,
): LoadAuthProfileStoreOptions | undefined {
  const mode = authProfileRuntimeMode.getStore();
  if (mode?.kind !== "agent-dir") {
    return options;
  }
  return { ...options, inheritedAuthDir: mode.agentDir };
}

let runtimeSnapshotPublisherForTest: ((publish: () => void) => void) | undefined;

type RuntimeSnapshotPublication = {
  agentDir?: string;
  databasePath: string;
  publish: () => boolean;
};

function publishRuntimeSnapshotsAfterCommit(
  publication: RuntimeSnapshotPublication | undefined,
): boolean {
  if (!publication) {
    return true;
  }
  // A committed write can no longer roll back, so publication failure must
  // evict only the exact derived owner that could now be stale.
  try {
    let converged = false;
    const publish = () => {
      converged = publication.publish();
    };
    if (runtimeSnapshotPublisherForTest) {
      runtimeSnapshotPublisherForTest(publish);
    } else {
      publish();
    }
    return converged;
  } catch (err) {
    clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
      publication.databasePath,
      publication.agentDir,
    );
    authProfilesLog.warn("auth profile store committed but runtime snapshot publication failed", {
      err,
    });
    return false;
  }
}

const testing = {
  resetRuntimeSnapshotPublisherForTest(): void {
    runtimeSnapshotPublisherForTest = undefined;
  },
  setRuntimeSnapshotPublisherForTest(publisher: (publish: () => void) => void): void {
    runtimeSnapshotPublisherForTest = publisher;
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.authProfileStoreTestApi")] =
    testing;
}

function resolvePersistedLoadOptions(
  options: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt" | "database"> | undefined,
): { allowKeychainPrompt?: boolean; database?: AuthProfileDatabase } {
  return {
    ...(options?.allowKeychainPrompt !== undefined
      ? { allowKeychainPrompt: options.allowKeychainPrompt }
      : {}),
    ...(options?.database ? { database: options.database } : {}),
  };
}

function loadPersistedAuthProfileStores(
  agentDir?: string,
  database?: AuthProfileDatabase,
  owner?: AuthProfileStoreOwner,
): PersistedAuthProfileStores {
  const localStore = loadPersistedAuthProfileStore(agentDir, database ? { database } : undefined);
  const localAuthPath =
    owner?.databasePath ?? (agentDir ? resolveAgentAuthPath(agentDir) : resolveSharedAuthPath());
  const isMainStore = localAuthPath === (owner?.sharedDatabasePath ?? resolveSharedAuthPath());
  return {
    isMainStore,
    localStore,
    mainStore: isMainStore
      ? localStore
      : owner
        ? loadPersistedAuthProfileStoreAtDatabasePath(
            owner.sharedDatabasePath,
            owner.location === "state-db" ? "shared-state" : "agent",
          )
        : loadPersistedAuthProfileStore(),
  };
}

function hasScopedExternalCliOverlay(options: ResolvedExternalCliOverlayOptions): boolean {
  return (
    options.externalCliProviderIds !== undefined || options.externalCliProfileIds !== undefined
  );
}

function shouldKeepProfileInLocalStore(params: {
  owner: AuthProfileStoreOwner;
  store: AuthProfileStore;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
  persistedStores: PersistedAuthProfileStores;
  externalProfiles: () => RuntimeExternalOAuthProfile[];
}): boolean {
  const inherited = getScopedSharedAuthStore()?.profiles[params.profileId];
  if (inherited && !params.persistedStores.localStore?.profiles[params.profileId]) {
    // Runtime state updates must not turn read-through credentials into local copies.
    // Compare persisted shapes so a materialized SecretRef stays inherited too.
    const secrets = buildPersistedAuthProfileSecretsStore({
      version: AUTH_STORE_VERSION,
      profiles: { [params.profileId]: params.credential },
    });
    if (isDeepStrictEqual(secrets.profiles[params.profileId], inherited)) {
      return false;
    }
  }
  if (params.credential.type !== "oauth") {
    return true;
  }
  if (
    isInheritedMainOAuthCredentialFromStores({
      profileId: params.profileId,
      credential: params.credential,
      persistedStores: params.persistedStores,
    })
  ) {
    return false;
  }
  if (params.options?.filterExternalAuthProfiles === false) {
    return true;
  }
  if (params.store.runtimeExternalProfileIds?.includes(params.profileId)) {
    // Runtime external profiles are normally overlays. Persist only when they
    // have explicit local state or differ from the runtime snapshot.
    const persistedCredential = params.persistedStores.localStore?.profiles[params.profileId];
    if (persistedCredential) {
      return shouldPersistRuntimeExternalOAuthProfile({
        profileId: params.profileId,
        credential: params.credential,
        profiles: params.externalProfiles(),
      });
    }
    const runtimeCredential = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(
      params.owner.databasePath,
    )?.profiles[params.profileId];
    if (!runtimeCredential || isDeepStrictEqual(runtimeCredential, params.credential)) {
      return false;
    }
  }
  return shouldPersistRuntimeExternalOAuthProfile({
    profileId: params.profileId,
    credential: params.credential,
    profiles: params.externalProfiles(),
  });
}

function convergeRuntimeAuthProfileStoreSnapshot(
  databasePath: string,
  agentDir: string | undefined,
  operation: () => void,
): boolean {
  try {
    operation();
    return true;
  } catch (err) {
    // A refused owner must not interrupt convergence of healthy sibling snapshots.
    clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath, agentDir);
    authProfilesLog.warn("auth profile snapshot convergence failed", { err });
    return false;
  }
}

function setRuntimeExternalProfileMetadata(params: {
  store: AuthProfileStore;
  profileIds: ReadonlySet<string>;
  authoritative: boolean;
}): void {
  const profileIds = [...params.profileIds].toSorted();
  params.store.runtimeExternalProfileIds =
    profileIds.length > 0 || params.authoritative ? profileIds : undefined;
  params.store.runtimeExternalProfileIdsAuthoritative = params.authoritative ? true : undefined;
  setRuntimeExternalCliProfileIds(
    params.store,
    getRuntimeExternalCliProfileIds(params.store).filter((profileId) =>
      params.profileIds.has(profileId),
    ),
  );
}

function materializeRuntimeAuthProfileStoreSnapshot(
  next: AuthProfileStore,
  existing: AuthProfileStore,
): AuthProfileStore {
  return mergeRuntimeExternalProfileReferences({
    next: preserveResolvedSecretBackedCredentials({ next, existing }),
    existing,
  });
}

function mergeRuntimeExternalProfileState(params: {
  next: AuthProfileStore;
  existing: AuthProfileStore;
}): AuthProfileStore {
  const existingRuntimeProfileIds = new Set(params.existing.runtimeExternalProfileIds ?? []);
  if (existingRuntimeProfileIds.size === 0) {
    return mergeRuntimeExternalProfileReferences(params);
  }
  const merged = cloneAuthProfileStore(params.next);
  const mergedRuntimeProfileIds = new Set(merged.runtimeExternalProfileIds ?? []);
  const existingRuntimeExternalCliProfileIds = new Set(
    getRuntimeExternalCliProfileIds(params.existing),
  );
  const mergedRuntimeExternalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(merged));
  const activeRuntimeProfileIds = new Set<string>();
  const nextRuntimeProfileIdsAuthoritative =
    params.next.runtimeExternalProfileIdsAuthoritative === true;
  for (const profileId of existingRuntimeProfileIds) {
    if (nextRuntimeProfileIdsAuthoritative && !mergedRuntimeProfileIds.has(profileId)) {
      continue;
    }
    const existingCredential = params.existing.profiles[profileId];
    if (!existingCredential) {
      continue;
    }
    const nextCredential = merged.profiles[profileId];
    if (
      nextCredential &&
      !mergedRuntimeProfileIds.has(profileId) &&
      !isDeepStrictEqual(nextCredential, existingCredential)
    ) {
      continue;
    }
    if (!nextCredential) {
      merged.profiles[profileId] = existingCredential;
    }
    mergedRuntimeProfileIds.add(profileId);
    activeRuntimeProfileIds.add(profileId);
    if (existingRuntimeExternalCliProfileIds.has(profileId)) {
      mergedRuntimeExternalCliProfileIds.add(profileId);
    }
  }
  if (activeRuntimeProfileIds.size === 0) {
    return params.next;
  }
  for (const profileId of activeRuntimeProfileIds) {
    if (params.existing.usageStats?.[profileId]) {
      merged.usageStats = {
        ...merged.usageStats,
        [profileId]: params.existing.usageStats[profileId],
      };
    }
  }
  for (const [provider, profileIds] of Object.entries(params.existing.order ?? {})) {
    const externalProfileIds = profileIds.filter((profileId) =>
      activeRuntimeProfileIds.has(profileId),
    );
    if (externalProfileIds.length === 0 || merged.order?.[provider]) {
      continue;
    }
    merged.order = {
      ...merged.order,
      [provider]: externalProfileIds,
    };
  }
  for (const [provider, profileId] of Object.entries(params.existing.lastGood ?? {})) {
    if (!activeRuntimeProfileIds.has(profileId) || merged.lastGood?.[provider]) {
      continue;
    }
    merged.lastGood = {
      ...merged.lastGood,
      [provider]: profileId,
    };
  }
  setRuntimeExternalProfileMetadata({
    store: merged,
    profileIds: mergedRuntimeProfileIds,
    authoritative: params.existing.runtimeExternalProfileIdsAuthoritative === true,
  });
  setRuntimeExternalCliProfileIds(merged, mergedRuntimeExternalCliProfileIds);
  return merged;
}

/** Whether an agent dir resolves to the shared main auth-profile owner. */
export function isSharedMainAuthProfileAgentDir(agentDir?: string): boolean {
  const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
  if (!effectiveAgentDir) {
    return true;
  }
  const mainAgentDir = resolveRuntimeAuthProfileAgentDir();
  const mainPath = mainAgentDir ? resolveAgentAuthPath(mainAgentDir) : resolveSharedAuthPath();
  return resolveAgentAuthPath(effectiveAgentDir) === mainPath;
}

/** Find a persisted credential in the scoped store, falling back to the main store. */
export function findPersistedAuthProfileCredential(params: {
  agentDir?: string;
  profileId: string;
}): AuthProfileStore["profiles"][string] | undefined {
  if (isEnvOnlyAuthProfileRuntime()) {
    return undefined;
  }
  if (isUserModelAuthProfileId(params.profileId)) {
    return authProfileRuntimeMode.getStore()
      ? undefined
      : readUserModelAuthProfile(params.profileId)?.credential;
  }
  const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
  const requestedStore = loadPersistedAuthProfileStore(agentDir);
  const requestedProfile = requestedStore?.profiles[params.profileId];
  const scopedSharedStore = getScopedSharedAuthStore();
  if (scopedSharedStore) {
    return requestedProfile ?? scopedSharedStore.profiles[params.profileId];
  }
  if (requestedProfile || !agentDir) {
    return requestedProfile;
  }

  if (isSharedMainAuthProfileAgentDir(agentDir)) {
    return requestedProfile;
  }

  return loadPersistedAuthProfileStore(resolveRuntimeAuthProfileAgentDir())?.profiles[
    params.profileId
  ];
}

/** Resolve which agent dir owns a persisted profile, accounting for inherited OAuth. */
export function resolvePersistedAuthProfileOwnerAgentDir(params: {
  agentDir?: string;
  profileId: string;
}): string | undefined {
  if (isEnvOnlyAuthProfileRuntime() || isUserModelAuthProfileId(params.profileId)) {
    return undefined;
  }
  const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
  if (!agentDir) {
    return undefined;
  }
  const requestedStore = loadPersistedAuthProfileStore(agentDir);
  if (isSharedMainAuthProfileAgentDir(agentDir)) {
    return undefined;
  }

  const mainAgentDir = resolveRuntimeAuthProfileAgentDir();
  const mainStore = loadPersistedAuthProfileStore(mainAgentDir);
  const requestedProfile = requestedStore?.profiles[params.profileId];
  if (requestedProfile) {
    return shouldUseMainOwnerForLocalOAuthCredential({
      profileId: params.profileId,
      local: requestedProfile,
      main: mainStore?.profiles[params.profileId],
    })
      ? undefined
      : agentDir;
  }

  return mainStore?.profiles[params.profileId] ? undefined : agentDir;
}

export {
  hasAnyAuthProfileStoreSource,
  hasAuthProfileStoreSourceForProvider,
  hasLocalAuthProfileStoreSource,
} from "./source-check.js";

/** Return the current runtime auth-profile snapshot for an agent dir. */
export function getRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
): AuthProfileStore | undefined {
  return getRuntimeAuthProfileStoreSnapshotCore(agentDir);
}

/** Return the lifecycle-published effective auth store without persisted fallback reads. */
export function getPreparedRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
  inheritedAuthDir?: string,
): AuthProfileStore | undefined {
  return getPreparedRuntimeAuthProfileStoreSnapshotCore(agentDir, inheritedAuthDir);
}

export { getRuntimeAuthProfileStoreSnapshotRevision };

/** Clear one runtime auth-profile snapshot. */
export function clearRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean {
  return clearRuntimeAuthProfileStoreSnapshotCore(agentDir);
}

type AuthProfileStorePersistenceSnapshot = {
  owner: PreparedAuthProfileStoreOwner;
  credentialsRaw: unknown;
  stateRaw: unknown;
  runtimeCaptured: boolean;
  runtimeRevision?: number;
  runtimeRevisionAtSaveEdge?: number;
  runtimeRevisionBeforePublication?: number;
  runtimeEntry?: OwnedRuntimeAuthProfileStoreSnapshotEntry;
  derivedRuntimeStores?: Array<
    OwnedRuntimeAuthProfileStoreSnapshotEntry & { runtimeRevision: number }
  >;
  derivedRuntimeRevisionsAtSaveEdge?: Array<{
    databasePath: string;
    agentDir: string;
    runtimeRevision: number;
  }>;
  derivedRuntimeRevisionsBeforePublication?: Array<{
    databasePath: string;
    agentDir: string;
    runtimeRevision: number;
  }>;
};

type CommittedAuthProfileStoreSave = {
  owned: AuthProfileStorePersistenceSnapshot;
  publishRuntimeSnapshots: () => boolean;
};

function assertAuthProfilePersistenceOwner(
  owner: PreparedAuthProfileStoreOwner,
  agentDir: string | undefined,
  stateDir?: string,
): void {
  if (
    stateDir &&
    path.resolve(resolveStateDir({ ...owner.env, OPENCLAW_STATE_DIR: stateDir })) !==
      path.resolve(resolveStateDir(owner.env))
  ) {
    throw new Error("explicit auth state directory does not match the captured owner");
  }
  const requestedPath = agentDir ? resolveAgentAuthPath(agentDir) : owner.sharedDatabasePath;
  if (requestedPath !== owner.databasePath) {
    throw new Error("auth profile persistence snapshot belongs to another owner");
  }
}

function captureRuntimeAuthProfileStorePersistenceSnapshot(
  owner: AuthProfileStoreOwner,
): Pick<
  AuthProfileStorePersistenceSnapshot,
  "runtimeCaptured" | "runtimeRevision" | "runtimeEntry" | "derivedRuntimeStores"
> {
  const capturedAuthPath = owner.databasePath;
  const mainAuthPath = owner.sharedDatabasePath;
  return {
    runtimeCaptured: true,
    runtimeRevision: getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(capturedAuthPath),
    runtimeEntry: getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(capturedAuthPath),
    derivedRuntimeStores:
      capturedAuthPath === mainAuthPath
        ? listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner).map((entry) =>
            Object.assign(entry, {
              runtimeRevision: getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(
                entry.databasePath,
              ),
            }),
          )
        : [],
  };
}

function recordRuntimeAuthProfileStoreOwnership(
  owned: AuthProfileStorePersistenceSnapshot,
  runtime: ReturnType<typeof captureRuntimeAuthProfileStorePersistenceSnapshot>,
): void {
  // The raw rows are the compare-and-swap token captured under the SQLite
  // transaction. Never replace them with a later persistence read.
  owned.runtimeCaptured = runtime.runtimeCaptured;
  if (runtime.runtimeRevision !== undefined) {
    owned.runtimeRevision = runtime.runtimeRevision;
  }
  if (runtime.runtimeEntry !== undefined) {
    owned.runtimeEntry = runtime.runtimeEntry;
  }
  if (runtime.derivedRuntimeStores !== undefined) {
    owned.derivedRuntimeStores = runtime.derivedRuntimeStores;
  }
}

function recordRuntimeAuthProfileStorePublicationEdge(
  owned: AuthProfileStorePersistenceSnapshot,
  runtime: ReturnType<typeof captureRuntimeAuthProfileStorePersistenceSnapshot>,
): void {
  if (runtime.runtimeRevision !== undefined) {
    owned.runtimeRevisionBeforePublication = runtime.runtimeRevision;
  }
  if (runtime.derivedRuntimeStores !== undefined) {
    owned.derivedRuntimeRevisionsBeforePublication = runtime.derivedRuntimeStores.flatMap(
      (entry) =>
        typeof entry.runtimeRevision === "number"
          ? [
              {
                databasePath: entry.databasePath,
                agentDir: entry.agentDir,
                runtimeRevision: entry.runtimeRevision,
              },
            ]
          : [],
    );
  }
}

function replaceRuntimeAuthProfileStoreSnapshot(
  entry: OwnedRuntimeAuthProfileStoreSnapshotEntry | undefined,
  agentDir: string | undefined,
  owner: AuthProfileStoreOwner,
): void {
  if (entry) {
    assertAuthProfileMigrationStateAtDatabasePath(entry.databasePath);
    if (entry.owner.kind === "resolved") {
      assertAuthProfileMigrationStateAtDatabasePath(entry.owner.sharedDatabasePath);
    }
    restoreOwnedRuntimeAuthProfileStoreSnapshot(entry, agentDir);
    return;
  }
  clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath, agentDir);
}

function refreshRuntimeAuthProfileStoreSnapshot(
  agentDir: string | undefined,
  owner: AuthProfileStoreOwner,
): void {
  const existing = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath);
  if (!existing) {
    return;
  }
  rebuildRuntimeAuthProfileStoreSnapshot(agentDir, existing, owner);
}

function rebuildRuntimeAuthProfileStoreSnapshot(
  agentDir: string | undefined,
  existing: OwnedRuntimeAuthProfileStoreSnapshotEntry,
  owner: AuthProfileStoreOwner | PreparedAuthProfileStoreOwner,
  predecessor?: AuthProfileStore,
  inheritedStore?: AuthProfileStore,
  capturedLocalProfileIds?: Iterable<string>,
): void {
  const isShared = owner.databasePath === owner.sharedDatabasePath;
  const candidates =
    "env" in owner
      ? captureRuntimeAuthProfileLegacyCandidates(isShared ? undefined : agentDir, owner.env)
      : runtimeAuthProfileSnapshotSharesOwner(existing.owner, owner)
        ? existing.legacyCandidates
        : undefined;
  let refreshed: AuthProfileStore;
  try {
    // Publication reads the complete canonical owner, never a bounded run's
    // portable-only view or a shared base selected from the current environment.
    refreshed = loadRuntimeAuthProfileOwnerSnapshot(owner, { candidates, inheritedStore });
  } catch (err) {
    if (!inheritedStore || err instanceof AuthProfileMigrationRequiredError) {
      throw err;
    }
    // Preserve only proven local rows when the committed shared store cannot be reread.
    const localProfileIds = new Set(capturedLocalProfileIds);
    const localStore = cloneAuthProfileStore(existing.store);
    localStore.profiles = Object.fromEntries(
      Object.entries(localStore.profiles).filter(([profileId]) => localProfileIds.has(profileId)),
    );
    pruneAuthProfileStoreReferences(localStore, localProfileIds);
    refreshed = mergeLocalAuthProfileStoreWithInheritedStore(localStore, inheritedStore);
    authProfilesLog.warn(
      "derived auth profile snapshot refresh failed; preserving captured local profiles",
      { err },
    );
  }
  publishPreparedRuntimeAuthProfileStoreSnapshot(agentDir, existing, owner, refreshed, {
    predecessor,
    candidates,
  });
}

/** Capture both persisted auth rows under one database lock. */
export function captureAuthProfileStorePersistenceSnapshot(
  agentDir?: string,
  options: { stateDir?: string; env?: NodeJS.ProcessEnv } = {},
): AuthProfileStorePersistenceSnapshot {
  const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
  return runAuthProfileWriteTransaction(
    effectiveAgentDir,
    (database, owner) => {
      return {
        owner,
        credentialsRaw: readPersistedAuthProfileStoreRaw(effectiveAgentDir, database),
        stateRaw: readPersistedAuthProfileStateRaw(effectiveAgentDir, database),
        ...captureRuntimeAuthProfileStorePersistenceSnapshot(owner),
      };
    },
    { ...options, env: options.env ?? (options.stateDir ? undefined : getScopedAuthProfileEnv()) },
  );
}

function reconcileRuntimeAuthProfileStorePersistenceSnapshot(params: {
  owner: AuthProfileStoreOwner;
  snapshot: AuthProfileStorePersistenceSnapshot;
  owned: AuthProfileStorePersistenceSnapshot;
  agentDir?: string;
  credentialsOwned: boolean;
  stateOwned: boolean;
  credentialsRestored: boolean;
  stateRestored: boolean;
  currentRuntimeStores: Array<
    OwnedRuntimeAuthProfileStoreSnapshotEntry & { runtimeRevision: number }
  >;
  currentRuntimeRevision: number;
}): boolean {
  if (!params.snapshot.runtimeCaptured || !params.owned.runtimeCaptured) {
    return true;
  }
  const rowsFullyOwned = params.credentialsOwned && params.stateOwned;
  const rowsRestored = params.credentialsRestored || params.stateRestored;
  const reconcileOne = (
    databasePath: string,
    agentDir: string | undefined,
    snapshotEntry: OwnedRuntimeAuthProfileStoreSnapshotEntry | undefined,
    snapshotRuntimeRevision: number | undefined,
    runtimeRevisionAtSaveEdge: number | undefined,
    runtimeRevisionBeforePublication: number | undefined,
    ownedEntry: OwnedRuntimeAuthProfileStoreSnapshotEntry | undefined,
    ownedRuntimeRevision: number | undefined,
    currentEntry: OwnedRuntimeAuthProfileStoreSnapshotEntry | undefined,
    currentRuntimeRevision: number,
  ) =>
    convergeRuntimeAuthProfileStoreSnapshot(databasePath, agentDir, () => {
      const runtimeGenerationOwned =
        typeof snapshotRuntimeRevision === "number" &&
        typeof runtimeRevisionAtSaveEdge === "number" &&
        typeof runtimeRevisionBeforePublication === "number" &&
        typeof ownedRuntimeRevision === "number" &&
        snapshotRuntimeRevision === runtimeRevisionAtSaveEdge &&
        runtimeRevisionAtSaveEdge === runtimeRevisionBeforePublication &&
        currentRuntimeRevision === ownedRuntimeRevision;
      if (
        rowsFullyOwned &&
        runtimeGenerationOwned &&
        isDeepStrictEqual(currentEntry?.store, ownedEntry?.store) &&
        isDeepStrictEqual(currentEntry?.owner, ownedEntry?.owner)
      ) {
        replaceRuntimeAuthProfileStoreSnapshot(snapshotEntry, agentDir, {
          ...params.owner,
          databasePath,
        });
      } else if (rowsRestored && currentEntry) {
        // Current overlays win, while the predecessor can still supply materialized
        // values. A newer runtime owner is independent of the transaction being undone.
        const runtimeOwner =
          currentEntry.owner.kind === "resolved"
            ? currentEntry.owner
            : runtimeAuthProfileSnapshotSharesOwner(currentEntry.owner, params.owner)
              ? params.owner
              : undefined;
        if (!runtimeOwner) {
          return;
        }
        const owner = {
          databasePath,
          sharedDatabasePath: runtimeOwner.sharedDatabasePath,
          location: runtimeOwner.location,
        };
        rebuildRuntimeAuthProfileStoreSnapshot(
          agentDir,
          currentEntry,
          owner,
          snapshotEntry && runtimeAuthProfileSnapshotSharesOwner(snapshotEntry.owner, runtimeOwner)
            ? snapshotEntry.store
            : undefined,
        );
      }
    });

  const restoredAuthPath = params.owner.databasePath;
  const mainAuthPath = params.owner.sharedDatabasePath;
  const currentRuntimeStores = new Map(
    params.currentRuntimeStores.map((entry) => [entry.databasePath, entry]),
  );
  let converged = reconcileOne(
    restoredAuthPath,
    params.agentDir,
    params.snapshot.runtimeEntry,
    params.snapshot.runtimeRevision,
    params.owned.runtimeRevisionAtSaveEdge,
    params.owned.runtimeRevisionBeforePublication,
    params.owned.runtimeEntry,
    params.owned.runtimeRevision,
    currentRuntimeStores.get(restoredAuthPath),
    params.currentRuntimeRevision,
  );
  if (restoredAuthPath !== mainAuthPath) {
    return converged;
  }
  const snapshotDerived = new Map(
    (params.snapshot.derivedRuntimeStores ?? []).map((entry) => [entry.databasePath, entry]),
  );
  const ownedDerived = new Map(
    (params.owned.derivedRuntimeStores ?? []).map((entry) => [entry.databasePath, entry]),
  );
  const saveEdgeDerivedRevisions = new Map(
    (params.owned.derivedRuntimeRevisionsAtSaveEdge ?? []).map((entry) => [
      entry.databasePath,
      entry.runtimeRevision,
    ]),
  );
  const publicationEdgeDerivedRevisions = new Map(
    (params.owned.derivedRuntimeRevisionsBeforePublication ?? []).map((entry) => [
      entry.databasePath,
      entry.runtimeRevision,
    ]),
  );
  for (const [pathname, currentEntry] of currentRuntimeStores) {
    if (pathname === mainAuthPath) {
      continue;
    }
    const snapshotEntry = snapshotDerived.get(pathname);
    const ownedEntry = ownedDerived.get(pathname);
    converged =
      reconcileOne(
        pathname,
        currentEntry.agentDir,
        snapshotEntry,
        snapshotEntry?.runtimeRevision,
        saveEdgeDerivedRevisions.get(pathname),
        publicationEdgeDerivedRevisions.get(pathname),
        ownedEntry,
        ownedEntry?.runtimeRevision,
        currentEntry,
        currentEntry.runtimeRevision,
      ) && converged;
  }
  return converged;
}

/** Restore each persisted row and runtime snapshot only while apply still owns it. */
export function restoreAuthProfileStorePersistenceSnapshot(
  snapshot: AuthProfileStorePersistenceSnapshot,
  owned: AuthProfileStorePersistenceSnapshot,
  agentDir?: string,
  options: { stateDir?: string } = {},
): void {
  assertAuthProfilePersistenceOwner(owned.owner, agentDir, options.stateDir);
  if (
    snapshot.owner.databasePath !== owned.owner.databasePath ||
    snapshot.owner.sharedDatabasePath !== owned.owner.sharedDatabasePath
  ) {
    throw new Error("auth profile rollback snapshots belong to different owners");
  }
  runAuthProfileWriteTransaction(
    agentDir,
    (database, owner) => {
      if (owned.owner.databasePath !== database.path) {
        throw new Error("auth profile rollback belongs to another database");
      }
      const existingRaw = readPersistedAuthProfileStoreRaw(agentDir, database);
      const existingState = readPersistedAuthProfileStateRaw(agentDir, database);
      const credentialsOwned = isDeepStrictEqual(existingRaw, owned.credentialsRaw);
      const stateOwned = isDeepStrictEqual(existingState, owned.stateRaw);
      const beforeProfiles =
        isRecord(existingRaw) && isRecord(existingRaw.profiles) ? existingRaw.profiles : {};
      const restoredProfiles =
        isRecord(snapshot.credentialsRaw) && isRecord(snapshot.credentialsRaw.profiles)
          ? snapshot.credentialsRaw.profiles
          : {};
      const changedProfileIds = [
        ...new Set([...Object.keys(beforeProfiles), ...Object.keys(restoredProfiles)]),
      ].filter(
        (profileId) => !isDeepStrictEqual(beforeProfiles[profileId], restoredProfiles[profileId]),
      );
      const profileSetChanged = changedProfileIds.some(
        (profileId) =>
          Object.hasOwn(beforeProfiles, profileId) !== Object.hasOwn(restoredProfiles, profileId),
      );
      const credentialsRestored =
        credentialsOwned && !isDeepStrictEqual(existingRaw, snapshot.credentialsRaw);
      const stateRestored = stateOwned && !isDeepStrictEqual(existingState, snapshot.stateRaw);

      if (credentialsRestored) {
        if (snapshot.credentialsRaw === null) {
          deletePersistedAuthProfileStoreRaw(agentDir, database);
        } else {
          writePersistedAuthProfileStoreRaw(snapshot.credentialsRaw, agentDir, database);
        }
      }
      if (stateRestored) {
        writePersistedAuthProfileStateRaw(snapshot.stateRaw, agentDir, database);
      }
      const publication: RuntimeSnapshotPublication = {
        ...(agentDir ? { agentDir } : {}),
        databasePath: owner.databasePath,
        publish: () => {
          // Main credential mutation lineage invalidates derived snapshots. Capture
          // them first so exact-owned entries can restore and newer entries rebuild.
          const currentRuntimeStores = [
            ...listOwnedRuntimeAuthProfileStoreSnapshots().filter(
              (entry) => entry.databasePath === owner.databasePath,
            ),
            ...(owner.databasePath === owner.sharedDatabasePath
              ? listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner)
              : []),
          ].map((entry) =>
            Object.assign(entry, {
              runtimeRevision: getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(
                entry.databasePath,
              ),
            }),
          );
          const currentRuntimePath = owner.databasePath;
          const currentRuntimeRevision =
            getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(currentRuntimePath);
          if (credentialsRestored || stateRestored) {
            noteRuntimeAuthProfileStorePersistedMutation(
              agentDir,
              {
                credentialsChanged: credentialsRestored,
                profileSetChanged: credentialsRestored && profileSetChanged,
                stateChanged: stateRestored,
                selectionChanged: stateRestored,
                profileIds: credentialsRestored ? changedProfileIds : [],
                oauthRefreshClaimIds: captureOAuthRefreshClaimPublication(
                  restoredProfiles,
                  credentialsRestored ? changedProfileIds : [],
                ),
              },
              owner,
            );
          }
          return reconcileRuntimeAuthProfileStorePersistenceSnapshot({
            owner,
            snapshot,
            owned,
            agentDir,
            credentialsOwned,
            stateOwned,
            credentialsRestored,
            stateRestored,
            currentRuntimeStores,
            currentRuntimeRevision,
          });
        },
      };
      deferSqlitePostCommitPublication(database.db, () =>
        publishRuntimeSnapshotsAfterCommit(publication),
      );
    },
    { env: owned.owner.env },
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

export { preserveResolvedSecretBackedCredentials } from "./runtime-snapshot-owner.js";

// Only external-profile-dependent operations are bound; module state stays above.
export function createAuthProfileStoreRuntime(
  externalAuth: ReturnType<typeof createExternalAuthRuntime>,
) {
  const { listRuntimeExternalAuthProfiles, overlayExternalAuthProfiles } = externalAuth;

  function resolveRuntimeAuthProfileStore(
    agentDir?: string,
    options?: Pick<
      LoadAuthProfileStoreOptions,
      "allowKeychainPrompt" | "inheritedAuthDir" | "migrationProvider" | "config"
    >,
  ): AuthProfileStore | null {
    // Ambient snapshots may include non-portable shared profiles. A bounded exec
    // scope composes its view from the actual local store and its filtered base.
    if (getScopedSharedAuthStore()) {
      return null;
    }
    return resolveRuntimeAuthProfileStoreFromSnapshots({
      agentDir,
      inheritedAuthDir: options?.inheritedAuthDir,
      env: getScopedAuthProfileEnv(),
      loadStore: (directory) =>
        loadAuthProfileStoreForAgent(directory, {
          migrationProvider: options?.migrationProvider,
          config: options?.config,
          readOnly: true,
          syncExternalCli: false,
          ...resolvePersistedLoadOptions(options),
        }),
    });
  }

  function maybeSyncPersistedExternalCliAuthProfiles(params: {
    store: AuthProfileStore;
    agentDir?: string;
    options?: LoadAuthProfileStoreOptions;
  }): AuthProfileStore {
    if (
      params.options?.readOnly === true ||
      params.options?.syncExternalCli === false ||
      process.env.OPENCLAW_AUTH_STORE_READONLY === "1"
    ) {
      return params.store;
    }
    const synced = syncPersistedExternalCliAuthProfiles(params.store, {
      agentDir: params.agentDir,
      ...resolveExternalCliOverlayOptions(params.options),
    });
    if (synced === params.store) {
      return params.store;
    }
    const changedProfiles = Object.entries(synced.profiles).filter(([profileId, credential]) => {
      const previous = params.store.profiles[profileId];
      return !isDeepStrictEqual(previous, credential);
    });
    if (changedProfiles.length === 0) {
      return synced;
    }

    // External CLI sync writes only profiles that still match the loaded
    // baseline, avoiding overwrite of concurrent local auth changes.
    try {
      return runAuthProfileWriteTransaction(
        params.agentDir,
        (database, owner) => {
          const latestStore = loadPersistedAuthProfileStore(params.agentDir, {
            ...resolvePersistedLoadOptions(params.options),
            database,
          }) ?? {
            version: AUTH_STORE_VERSION,
            profiles: {},
          };
          let changed = false;
          for (const [profileId, credential] of changedProfiles) {
            const previous = params.store.profiles[profileId];
            const latest = latestStore.profiles[profileId];
            if (!isDeepStrictEqual(latest, previous)) {
              authProfilesLog.debug(
                "skipped persisted external cli auth sync for concurrently changed profile",
                {
                  profileId,
                },
              );
              continue;
            }
            latestStore.profiles[profileId] = credential;
            changed = true;
          }
          if (changed) {
            const publication = saveAuthProfileStoreInTransaction(
              latestStore,
              params.agentDir,
              {
                filterExternalAuthProfiles: false,
              },
              database,
              owner,
            );
            deferSqlitePostCommitPublication(database.db, () =>
              publishRuntimeSnapshotsAfterCommit(publication),
            );
          }
          return latestStore;
        },
        { env: getScopedAuthProfileEnv() },
      );
    } catch (err) {
      authProfilesLog.warn(
        "skipped persisted external cli auth sync because auth store write failed",
        {
          err,
        },
      );
      return params.store;
    }
  }

  function buildLocalAuthProfileStoreForSave(params: {
    owner: AuthProfileStoreOwner;
    store: AuthProfileStore;
    agentDir?: string;
    options?: SaveAuthProfileStoreOptions;
    persistedStores: PersistedAuthProfileStores;
  }): AuthProfileStore {
    const localStore = cloneAuthProfileStore(removePersonalAuthProfileReferences(params.store));
    let externalProfiles: RuntimeExternalOAuthProfile[] | undefined;
    const getExternalProfiles = (): RuntimeExternalOAuthProfile[] =>
      (externalProfiles ??= listRuntimeExternalAuthProfiles({
        store: params.store,
        agentDir: params.agentDir,
      }));
    localStore.profiles = Object.fromEntries(
      Object.entries(localStore.profiles).filter(([profileId, credential]) =>
        shouldKeepProfileInLocalStore({
          owner: params.owner,
          store: params.store,
          profileId,
          credential,
          agentDir: params.agentDir,
          options: params.options,
          persistedStores: params.persistedStores,
          externalProfiles: getExternalProfiles,
        }),
      ),
    );
    const keptProfileIds = new Set(Object.keys(localStore.profiles));
    const keptOrderProfileIds = new Set(keptProfileIds);
    for (const profileId of normalizeUniqueStringEntries(params.options?.preserveStateProfileIds)) {
      keptProfileIds.add(profileId);
      keptOrderProfileIds.add(profileId);
    }
    for (const profileIds of Object.values(params.persistedStores.localStore?.order ?? {})) {
      for (const profileId of profileIds) {
        keptOrderProfileIds.add(profileId);
      }
    }
    for (const profileId of normalizeUniqueStringEntries(params.options?.preserveOrderProfileIds)) {
      keptOrderProfileIds.add(profileId);
    }
    for (const profileId of normalizeUniqueStringEntries(params.options?.pruneOrderProfileIds)) {
      keptOrderProfileIds.delete(profileId);
    }
    for (const profileId of keptProfileIds) {
      if (isUserModelAuthProfileId(profileId)) {
        keptProfileIds.delete(profileId);
      }
    }
    for (const profileId of keptOrderProfileIds) {
      if (isUserModelAuthProfileId(profileId)) {
        keptOrderProfileIds.delete(profileId);
      }
    }
    pruneAuthProfileStoreReferences(localStore, keptProfileIds, keptOrderProfileIds);
    if (params.options?.filterExternalAuthProfiles !== false) {
      localStore.runtimeExternalProfileIds = undefined;
      localStore.runtimeExternalProfileIdsAuthoritative = undefined;
      setRuntimeExternalCliProfileIds(localStore, []);
    }
    return localStore;
  }

  function buildAuthProfileStoreWithoutExternalProfiles(params: {
    store: AuthProfileStore;
    agentDir?: string;
    options?: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt" | "inheritedAuthDir">;
  }): AuthProfileStore {
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
    const persistedStore = loadAuthProfileStoreWithoutExternalProfiles(
      params.agentDir,
      params.options,
    );
    return stripRuntimeExternalProfileMetadata(mergeAuthProfileStores(persistedStore, localStore));
  }

  /** Apply an auth store update inside the SQLite write lock; null only on lock contention. */
  async function updateAuthProfileStoreWithLock(params: {
    agentDir?: string;
    profileId?: string;
    sharedStoreWrite?: boolean;
    stateDir?: string;
    saveOptions?: SaveAuthProfileStoreOptions;
    updater: (store: AuthProfileStore, owner?: PreparedAuthProfileStoreOwner) => boolean;
  }): Promise<AuthProfileStore | null> {
    const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
    try {
      if (params.profileId && isUserModelAuthProfileId(params.profileId)) {
        if (authProfileRuntimeMode.getStore()) {
          throw new Error(
            "Personal model accounts are unavailable in an isolated auth-store scope.",
          );
        }
        return updatePersonalAuthProfileStore({
          profileId: params.profileId,
          updater: params.updater,
          stateDir: params.stateDir,
        });
      }
      return await runAuthProfileWriteTransactionAsync(
        agentDir,
        (database, owner) => {
          const loadedStore = loadAuthProfileStoreForAgent(
            agentDir,
            {
              database,
              readOnly: true,
              syncExternalCli: false,
            },
            owner.env,
          );
          const shouldSave = params.updater(loadedStore, owner);
          if (shouldSave) {
            const publication = saveAuthProfileStoreInTransaction(
              loadedStore,
              agentDir,
              params.saveOptions,
              database,
              owner,
            );
            deferSqlitePostCommitPublication(database.db, () =>
              publishRuntimeSnapshotsAfterCommit(publication),
            );
          }
          return loadedStore;
        },
        {
          sharedStoreWrite: params.sharedStoreWrite,
          stateDir: params.stateDir,
          env: params.stateDir ? undefined : getScopedAuthProfileEnv(),
        },
      );
    } catch (error) {
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
  }

  /** Load the main auth profile store with runtime external profiles overlaid. */
  function loadAuthProfileStore(): AuthProfileStore {
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    const agentDir = resolveRuntimeAuthProfileAgentDir();
    const store = loadPersistedAuthProfileStore(agentDir) ?? createEmptyAuthProfileStore();
    return overlayExternalAuthProfiles(
      applyScopedAuthReadThrough(markRuntimePersistedProfiles(store)),
      { agentDir },
    );
  }

  function loadAuthProfileStoreForAgent(
    agentDir?: string,
    options?: LoadAuthProfileStoreOptions,
    env?: NodeJS.ProcessEnv,
    preparedRows?: Parameters<typeof loadPersistedAuthProfileStoreFromRows>[0],
  ): AuthProfileStore {
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const effectiveOptions = resolveRuntimeAuthProfileLoadOptions(options);
    const databasePath = effectiveAgentDir
      ? resolveAgentAuthPath(effectiveAgentDir)
      : resolveSharedAuthPath(env);
    const readStore = () => {
      if (preparedRows) {
        return loadPersistedAuthProfileStoreFromRows(preparedRows, databasePath);
      }
      const store =
        !effectiveAgentDir && env && !effectiveOptions?.database
          ? loadPersistedSharedAuthProfileStore(env)
          : loadPersistedAuthProfileStore(
              effectiveAgentDir,
              resolvePersistedLoadOptions(effectiveOptions),
            );
      if (
        !store &&
        (!effectiveAgentDir && env && !effectiveOptions?.database
          ? inspectPersistedSharedAuthProfileStoreRaw(env)
          : inspectPersistedAuthProfileStoreRaw(effectiveAgentDir, effectiveOptions?.database)
        ).status !== "missing"
      ) {
        throw new AuthProfileStoreUnreadableError(effectiveOptions?.database?.path ?? databasePath);
      }
      return store;
    };
    effectiveOptions?.onReadOwner?.({
      databasePath,
      candidates: resolveLegacyAuthProfileSourceCandidates({ agentDir: effectiveAgentDir, env }),
      readStore,
    });
    if (preparedRows) {
      assertAuthProfileMigrationCandidates({
        databasePath,
        candidates: resolveLegacyAuthProfileSourceCandidates({ agentDir: effectiveAgentDir, env }),
        hasCredentials: () => {
          const raw = preparedRows.store.status === "readable" ? preparedRows.store.raw : undefined;
          return isRecord(raw) && isRecord(raw.profiles) && Object.keys(raw.profiles).length > 0;
        },
        provider: effectiveOptions?.migrationProvider,
        config: effectiveOptions?.config,
        deferScopedRefusals: effectiveOptions?.deferScopedMigrationRefusals,
      });
    } else {
      assertAuthProfileMigrationReady(
        effectiveAgentDir,
        env,
        effectiveOptions?.migrationProvider,
        effectiveOptions?.config,
        effectiveOptions?.deferScopedMigrationRefusals,
      );
    }
    const store = readStore();
    const legacySources = listLegacyAuthProfileSources({
      agentDir: effectiveAgentDir,
      env,
    });
    assertAuthProfileMigrationCandidates({
      databasePath,
      candidates: legacySources,
      hasCredentials: () => Boolean(store && Object.keys(store.profiles).length > 0),
      provider: effectiveOptions?.migrationProvider,
      config: effectiveOptions?.config,
      deferScopedRefusals: effectiveOptions?.deferScopedMigrationRefusals,
    });
    const credentialSources = legacySources.filter((source) => source.kind !== "auth-state");
    if (credentialSources.length === 0 || (store && Object.keys(store.profiles).length > 0)) {
      warnLegacyAuthProfileSourcesIgnored({
        agentDir: effectiveAgentDir,
        env,
        sources: legacySources,
      });
    }
    const synced = maybeSyncPersistedExternalCliAuthProfiles({
      store:
        store && effectiveOptions?.onReadOwner
          ? withCredentialSources(store, effectiveOptions.database?.path ?? databasePath)
          : (store ?? createEmptyAuthProfileStore()),
      agentDir: effectiveAgentDir,
      options: effectiveOptions,
    });
    return applyScopedAuthReadThrough(markRuntimePersistedProfiles(synced));
  }

  const { loadAuthProfileStoreForRuntime, loadAuthProfileStoreForRuntimeAsync } =
    createAuthProfileStoreRuntimeReader({
      isEnvOnlyAuthProfileRuntime,
      getScopedAuthProfileEnv,
      resolveRuntimeAuthProfileAgentDir,
      resolveRuntimeAuthProfileLoadOptions,
      loadAuthProfileStoreForAgent,
      overlayExternalAuthProfiles,
      captureScope: () => {
        const mode = authProfileRuntimeMode.getStore();
        return {
          isolated: Boolean(mode),
          run: (agentDir, env, run) =>
            mode?.kind === "agent-dir"
              ? authProfileRuntimeMode.run({ ...mode, agentDir: agentDir!, env }, run)
              : run(),
        };
      },
    });

  /** Retain read owners, never copies of their migration refusals, for a session facade. */
  function createAuthProfileStoreReadScope(agentDir: string, config: OpenClawConfig | undefined) {
    let mode = authProfileRuntimeMode.getStore();
    const env = { ...(mode?.kind === "agent-dir" ? mode.env : process.env) };
    const effectiveAgentDir = mode?.kind === "agent-dir" ? mode.agentDir : agentDir;
    const owners = new Map<string, AuthProfileReadOwner>();
    if (mode?.kind === "agent-dir" && mode.sharedStore) {
      const databasePath = resolveSharedAuthPath(env);
      mode = { ...mode, sharedStore: withCredentialSources(mode.sharedStore, databasePath) };
      owners.set(databasePath, {
        databasePath,
        candidates: resolveLegacyAuthProfileSourceCandidates({ env }),
        readStore: () => loadPersistedSharedAuthProfileStore(env),
      });
    }
    const read = (): AuthProfileStore => {
      const load = () =>
        loadAuthProfileStoreForRuntime(
          effectiveAgentDir,
          {
            config,
            readOnly: true,
            allowKeychainPrompt: false,
            deferScopedMigrationRefusals: true,
            onReadOwner: (owner) => {
              owners.set(owner.databasePath, owner);
            },
          },
          env,
        );
      const store = mode
        ? authProfileRuntimeMode.run(mode, load)
        : authProfileRuntimeMode.exit(load);
      // Supplied shared snapshots must still honor their owner's all-provider refusal.
      for (const owner of owners.values()) {
        assertAuthProfileMigrationStateAtDatabasePath(owner.databasePath, undefined, config, true);
      }
      return store;
    };
    const store = read();
    return {
      agentDir: effectiveAgentDir,
      store,
      read,
      getRuntimeSnapshots: () =>
        [...owners.keys()]
          .map((databasePath) => getRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath))
          .filter((snapshot) => snapshot !== undefined),
      assertCredentialReady: (source: AuthProfileCredentialSource, baseUrl?: string) => {
        const requestConfig =
          config && baseUrl !== undefined
            ? projectModelProviderConfig(config, source.provider, { baseUrl })
            : config;
        assertAuthProfileCredentialMigrationStateAtDatabasePath(
          source.databasePath,
          source.provider,
          requestConfig,
        );
      },
      assertProviderReady: (provider?: string, baseUrl?: string) => {
        const requestConfig =
          config && provider && baseUrl !== undefined
            ? projectModelProviderConfig(config, provider, { baseUrl })
            : config;
        for (const owner of owners.values()) {
          assertAuthProfileMigrationCandidates({
            databasePath: owner.databasePath,
            candidates: owner.candidates,
            hasCredentials: () => Object.keys(owner.readStore()?.profiles ?? {}).length > 0,
            provider,
            config: requestConfig,
          });
        }
      },
    };
  }

  /** Load auth profiles for secret resolution without keychain prompts or writes. */
  function loadAuthProfileStoreForSecretsRuntime(
    agentDir?: string,
    options?: Pick<
      LoadAuthProfileStoreOptions,
      | "config"
      | "profileId"
      | "externalCli"
      | "externalCliProviderIds"
      | "externalCliProfileIds"
      | "inheritedAuthDir"
    >,
  ): AuthProfileStore {
    return loadAuthProfileStoreForRuntime(agentDir, {
      ...options,
      readOnly: true,
      allowKeychainPrompt: false,
    });
  }

  /** Load auth profiles with runtime external profiles removed from the result. */
  function loadAuthProfileStoreWithoutExternalProfiles(
    agentDir?: string,
    loadOptions?: Pick<
      LoadAuthProfileStoreOptions,
      "allowKeychainPrompt" | "inheritedAuthDir" | "profileId"
    >,
  ): AuthProfileStore {
    if (loadOptions?.profileId && isUserModelAuthProfileId(loadOptions.profileId)) {
      const shared = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
        ...loadOptions,
        profileId: undefined,
      });
      return authProfileRuntimeMode.getStore()
        ? shared
        : materializePersonalAuthProfile(shared, loadOptions.profileId);
    }
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const effectiveLoadOptions = resolveRuntimeAuthProfileLoadOptions(loadOptions);
    const options: LoadAuthProfileStoreOptions = {
      readOnly: true,
      allowKeychainPrompt: effectiveLoadOptions?.allowKeychainPrompt ?? false,
      ...(effectiveLoadOptions?.inheritedAuthDir
        ? { inheritedAuthDir: effectiveLoadOptions.inheritedAuthDir }
        : {}),
    };
    const store = loadAuthProfileStoreForAgent(effectiveAgentDir, options);
    const authPath = effectiveAgentDir
      ? resolveAgentAuthPath(effectiveAgentDir)
      : resolveSharedAuthPath();
    const mainAuthPath = options.inheritedAuthDir
      ? resolveAgentAuthPath(options.inheritedAuthDir)
      : resolveSharedAuthPath();
    if (!effectiveAgentDir || authPath === mainAuthPath) {
      return setRuntimeLocalProfileMetadata(
        stripRuntimeExternalProfileMetadata(store),
        listRuntimeLocalProfileIds(store),
      );
    }

    const mainStore = loadInheritedAuthProfileStore(
      () => loadAuthProfileStoreForAgent(options.inheritedAuthDir, options),
      options.inheritedAuthDir,
      getScopedAuthProfileEnv(),
    );
    return stripRuntimeExternalProfileMetadata(
      mergeLocalAuthProfileStoreWithInheritedStore(store, mainStore),
    );
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
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    if (options?.profileId && isUserModelAuthProfileId(options.profileId)) {
      const shared = ensureAuthProfileStore(agentDir, { ...options, profileId: undefined });
      return authProfileRuntimeMode.getStore()
        ? shared
        : materializePersonalAuthProfile(shared, options.profileId);
    }
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const effectiveOptions = resolveRuntimeAuthProfileLoadOptions(options);
    const externalCli = resolveExternalCliOverlayOptions(effectiveOptions);
    const runtimeStore = resolveRuntimeAuthProfileStore(effectiveAgentDir, effectiveOptions);
    const store = overlayExternalAuthProfiles(
      ensureAuthProfileStoreWithoutExternalProfiles(effectiveAgentDir, effectiveOptions),
      {
        agentDir: effectiveAgentDir,
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
    if (hasScopedExternalCliOverlay(externalCli)) {
      // Scoped turn/control-plane resolution returns only the requested overlay, but the lifecycle
      // snapshot must retain unrelated external profiles. Publish the merged owner fact so prepared
      // model and chat metadata generations converge without reopening credential sources.
      const materialized = mergeRuntimeExternalProfileState({
        next: store,
        existing: runtimeStore,
      });
      if (!areAuthProfileStoresEqual(materialized, runtimeStore)) {
        updateRuntimeAuthProfileStoreSnapshot(materialized, effectiveAgentDir);
      }
      return store;
    }
    return mergeRuntimeExternalProfileState({
      next: store,
      existing: runtimeStore,
    });
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
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    if (options?.profileId && isUserModelAuthProfileId(options.profileId)) {
      const shared = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        ...options,
        profileId: undefined,
      });
      return authProfileRuntimeMode.getStore()
        ? shared
        : materializePersonalAuthProfile(shared, options.profileId);
    }
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const effectiveOptions: LoadAuthProfileStoreOptions = resolveRuntimeAuthProfileLoadOptions(
      options,
    ) ?? { ...options };
    const runtimeStore = resolveRuntimeAuthProfileStore(effectiveAgentDir, effectiveOptions);
    if (runtimeStore) {
      return buildAuthProfileStoreWithoutExternalProfiles({
        store: runtimeStore,
        agentDir: effectiveAgentDir,
        options: effectiveOptions,
      });
    }
    const store = loadAuthProfileStoreForAgent(effectiveAgentDir, effectiveOptions);
    const authPath = effectiveAgentDir
      ? resolveAgentAuthPath(effectiveAgentDir)
      : resolveSharedAuthPath();
    const mainAuthPath = effectiveOptions.inheritedAuthDir
      ? resolveAgentAuthPath(effectiveOptions.inheritedAuthDir)
      : resolveSharedAuthPath();
    if (!effectiveAgentDir || authPath === mainAuthPath) {
      return stripRuntimeExternalProfileMetadata(store);
    }

    const mainStore = loadInheritedAuthProfileStore(
      () => loadAuthProfileStoreForAgent(effectiveOptions.inheritedAuthDir, effectiveOptions),
      effectiveOptions.inheritedAuthDir,
      getScopedAuthProfileEnv(),
    );
    return stripRuntimeExternalProfileMetadata(
      mergeLocalAuthProfileStoreWithInheritedStore(store, mainStore),
    );
  }

  /** Load the store shape used when applying local-only auth updates. */
  function ensureAuthProfileStoreForLocalUpdate(agentDir?: string): AuthProfileStore {
    if (isEnvOnlyAuthProfileRuntime()) {
      return createEmptyAuthProfileStore();
    }
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    const options: LoadAuthProfileStoreOptions = { syncExternalCli: false };
    const store = loadAuthProfileStoreForAgent(effectiveAgentDir, options);
    const authPath = effectiveAgentDir
      ? resolveAgentAuthPath(effectiveAgentDir)
      : resolveSharedAuthPath();
    const mainAgentDir = resolveRuntimeAuthProfileAgentDir();
    const mainAuthPath = mainAgentDir
      ? resolveAgentAuthPath(mainAgentDir)
      : resolveSharedAuthPath();
    if (!effectiveAgentDir || authPath === mainAuthPath) {
      return store;
    }

    const mainStore = loadInheritedAuthProfileStore(
      () => loadAuthProfileStoreForAgent(undefined, { readOnly: true, syncExternalCli: false }),
      undefined,
      getScopedAuthProfileEnv(),
    );
    return mergeLocalAuthProfileStoreWithInheritedStore(store, mainStore);
  }

  function saveAuthProfileStoreInTransaction(
    store: AuthProfileStore,
    agentDir: string | undefined,
    options: SaveAuthProfileStoreOptions | undefined,
    database: AuthProfileDatabase,
    owner: AuthProfileStoreOwner | PreparedAuthProfileStoreOwner,
    publishFromSuppliedStore = false,
  ): RuntimeSnapshotPublication {
    // Shared-state rows are global: never scope their persistence or runtime snapshots to an
    // agent, or shared credentials are published and cached as agent-local state.
    const persistenceAgentDir = "agentId" in database ? agentDir : undefined;
    const savedAuthPath = owner.databasePath;
    const mainAuthPath = owner.sharedDatabasePath;
    const savesMainStore = savedAuthPath === mainAuthPath;
    const loadedPersistedStores = loadPersistedAuthProfileStores(
      persistenceAgentDir,
      database,
      owner,
    );
    const persistedStores: PersistedAuthProfileStores = {
      ...loadedPersistedStores,
      localStore: loadedPersistedStores.localStore ?? {
        version: AUTH_STORE_VERSION,
        profiles: {},
        ...loadPersistedAuthProfileState(persistenceAgentDir, database),
      },
    };
    const localStore = buildLocalAuthProfileStoreForSave({
      owner,
      store,
      agentDir: persistenceAgentDir,
      options,
      persistedStores,
    });
    const existingRaw = readPersistedAuthProfileStoreRaw(persistenceAgentDir, database);
    const { payload, statePayload, publication } = prepareAuthProfileStoreMutation({
      existingRaw,
      existingState: readPersistedAuthProfileStateRaw(persistenceAgentDir, database),
      store: localStore,
      selectionProfiles: {
        ...persistedStores.mainStore?.profiles,
        ...store.profiles,
        ...localStore.profiles,
      },
    });
    const { credentialsChanged, stateChanged } = publication;
    const suppliedRuntimeStore = publishFromSuppliedStore
      ? markRuntimePersistedProfiles(
          buildLocalAuthProfileStoreForSave({
            owner,
            store,
            agentDir: persistenceAgentDir,
            options: { ...options, filterExternalAuthProfiles: false },
            persistedStores,
          }),
          localStore,
        )
      : undefined;
    if (credentialsChanged) {
      writePersistedAuthProfileStoreRaw(payload, persistenceAgentDir, database);
    }
    if (stateChanged) {
      writePersistedAuthProfileStateRaw(statePayload, persistenceAgentDir, database);
    }
    const committedSharedStore = savesMainStore
      ? setRuntimeLocalProfileMetadata(
          markRuntimePersistedProfiles(localStore),
          listRuntimeLocalProfileIds(localStore),
        )
      : undefined;
    const publishRuntimeSnapshots = () => {
      // Main-store publication invalidates derived stores. Capture the latest
      // overlays at the publication edge so post-commit refreshes are retained.
      const derivedSnapshots = savesMainStore
        ? listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner)
        : [];
      if (credentialsChanged || stateChanged) {
        noteRuntimeAuthProfileStorePersistedMutation(persistenceAgentDir, publication, owner);
      }
      try {
        assertAuthProfileMigrationStateAtDatabasePath(savedAuthPath);
      } catch (error) {
        // A refused materialization does not undo committed mutation facts. State-only
        // writes need explicit eviction too; credential mutation already invalidates them.
        for (const derived of derivedSnapshots) {
          clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
            derived.databasePath,
            derived.agentDir,
          );
        }
        throw error;
      }
      if (suppliedRuntimeStore) {
        const existing = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(savedAuthPath);
        if (existing) {
          const materialized = runtimeAuthProfileSnapshotSharesOwner(existing.owner, owner)
            ? materializeRuntimeAuthProfileStoreSnapshot(suppliedRuntimeStore, existing.store)
            : suppliedRuntimeStore;
          setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
            materialized,
            savedAuthPath,
            persistenceAgentDir,
            owner,
          );
        }
        if (!credentialsChanged && !stateChanged) {
          return true;
        }
      } else if (savesMainStore) {
        const existing = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(savedAuthPath);
        if (existing) {
          setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
            runtimeAuthProfileSnapshotSharesOwner(existing.owner, owner)
              ? materializeRuntimeAuthProfileStoreSnapshot(committedSharedStore!, existing.store)
              : committedSharedStore!,
            savedAuthPath,
            persistenceAgentDir,
            owner,
          );
        }
      } else {
        refreshRuntimeAuthProfileStoreSnapshot(persistenceAgentDir, owner);
      }
      let converged = true;
      for (const derived of derivedSnapshots) {
        converged =
          convergeRuntimeAuthProfileStoreSnapshot(derived.databasePath, derived.agentDir, () =>
            rebuildRuntimeAuthProfileStoreSnapshot(
              derived.agentDir,
              derived,
              { ...owner, databasePath: derived.databasePath },
              undefined,
              committedSharedStore,
              derived.store.runtimeLocalProfileIds,
            ),
          ) && converged;
      }
      return converged;
    };
    return {
      ...(persistenceAgentDir ? { agentDir: persistenceAgentDir } : {}),
      databasePath: savedAuthPath,
      publish: publishRuntimeSnapshots,
    };
  }

  /** Save the auth profile store plus sidecar state, preserving runtime overlay metadata. */
  function saveAuthProfileStore(
    store: AuthProfileStore,
    agentDir?: string,
    options?: SaveAuthProfileStoreOptions,
    database?: AuthProfileDatabase,
  ): void {
    const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
    if (database) {
      // Retain a prepared transaction owner, or use a shared connection's canonical identity.
      saveAuthProfileStoreWithPreparedOwner(
        store,
        effectiveAgentDir,
        options,
        database,
        resolveAuthProfileStoreOwner(database, getScopedAuthProfileEnv()),
      );
      return;
    }
    runAuthProfileWriteTransaction(
      effectiveAgentDir,
      (transactionDatabase, owner) => {
        const publication = saveAuthProfileStoreInTransaction(
          store,
          effectiveAgentDir,
          options,
          transactionDatabase,
          owner,
        );
        deferSqlitePostCommitPublication(transactionDatabase.db, () =>
          publishRuntimeSnapshotsAfterCommit(publication),
        );
      },
      { sharedStoreWrite: options?.sharedStoreWrite, env: getScopedAuthProfileEnv() },
    );
  }

  /** Core transaction callers carry the owner already selected before opening SQLite. */
  function saveAuthProfileStoreWithPreparedOwner(
    store: AuthProfileStore,
    agentDir: string | undefined,
    options: SaveAuthProfileStoreOptions | undefined,
    database: AuthProfileDatabase,
    owner: AuthProfileStoreOwner | PreparedAuthProfileStoreOwner,
  ): void {
    const publish = saveAuthProfileStoreInTransaction(
      store,
      agentDir,
      options,
      database,
      owner,
      true,
    );
    const publishAfterCommit = () => {
      publishRuntimeSnapshotsAfterCommit(publish);
    };
    if (!deferSqlitePostCommitPublication(database.db, publishAfterCommit)) {
      publishAfterCommit();
    }
  }

  /**
   * Commit only while both persisted auth rows still match the captured baseline.
   * The caller claims `owned` before publishing because publication is fallible.
   */
  function saveAuthProfileStoreIfPersistenceSnapshotMatches(params: {
    store: AuthProfileStore;
    snapshot: AuthProfileStorePersistenceSnapshot;
    agentDir?: string;
    options?: SaveAuthProfileStoreOptions;
    stateDir?: string;
  }): CommittedAuthProfileStoreSave {
    const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
    assertAuthProfilePersistenceOwner(params.snapshot.owner, agentDir, params.stateDir);
    let publishRuntimeSnapshots: RuntimeSnapshotPublication | undefined;
    const owned = runAuthProfileWriteTransaction(
      agentDir,
      (database, owner) => {
        if (params.snapshot.owner.databasePath !== database.path) {
          throw new Error("auth profile persistence snapshot belongs to another database");
        }
        const currentCredentials = readPersistedAuthProfileStoreRaw(agentDir, database);
        const currentState = readPersistedAuthProfileStateRaw(agentDir, database);
        if (
          !isDeepStrictEqual(currentCredentials, params.snapshot.credentialsRaw) ||
          !isDeepStrictEqual(currentState, params.snapshot.stateRaw)
        ) {
          throw new Error("auth profile store changed after secrets apply captured it");
        }
        const runtimeAtSaveEdge = captureRuntimeAuthProfileStorePersistenceSnapshot(owner);
        const derivedRuntimeRevisionsAtSaveEdge = runtimeAtSaveEdge.derivedRuntimeStores?.flatMap(
          (entry) =>
            typeof entry.runtimeRevision === "number"
              ? [
                  {
                    databasePath: entry.databasePath,
                    agentDir: entry.agentDir,
                    runtimeRevision: entry.runtimeRevision,
                  },
                ]
              : [],
        );
        publishRuntimeSnapshots = saveAuthProfileStoreInTransaction(
          params.store,
          agentDir,
          params.options,
          database,
          owner,
        );
        return {
          owner,
          credentialsRaw: readPersistedAuthProfileStoreRaw(agentDir, database),
          stateRaw: readPersistedAuthProfileStateRaw(agentDir, database),
          runtimeCaptured: false,
          runtimeRevisionAtSaveEdge: runtimeAtSaveEdge.runtimeRevision,
          derivedRuntimeRevisionsAtSaveEdge,
        } satisfies AuthProfileStorePersistenceSnapshot;
      },
      { env: params.snapshot.owner.env },
    );
    return {
      owned,
      publishRuntimeSnapshots: () => {
        if (!publishRuntimeSnapshots) {
          return true;
        }
        const publication = publishRuntimeSnapshots;
        return publishRuntimeSnapshotsAfterCommit({
          ...publication,
          publish: () => {
            const owner = owned.owner;
            recordRuntimeAuthProfileStorePublicationEdge(
              owned,
              captureRuntimeAuthProfileStorePersistenceSnapshot(owner),
            );
            const converged = publication.publish();
            recordRuntimeAuthProfileStoreOwnership(
              owned,
              captureRuntimeAuthProfileStorePersistenceSnapshot(owner),
            );
            return converged;
          },
        });
      },
    };
  }

  return {
    createAuthProfileStoreReadScope,
    updateAuthProfileStoreWithLock,
    loadAuthProfileStore,
    loadAuthProfileStoreForRuntime,
    loadAuthProfileStoreForRuntimeAsync,
    loadAuthProfileStoreForSecretsRuntime,
    loadAuthProfileStoreWithoutExternalProfiles,
    ensureAuthProfileStore,
    ensureAuthProfileStoreWithoutExternalProfiles,
    ensureAuthProfileStoreForLocalUpdate,
    saveAuthProfileStore,
    saveAuthProfileStoreWithPreparedOwner,
    saveAuthProfileStoreIfPersistenceSnapshotMatches,
    findPersistedAuthProfileCredential,
  };
}
