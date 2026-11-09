import path from "node:path";
/**
 * Process-local auth profile snapshots used by prepared runtimes and tests.
 * Snapshots are cloned at boundaries so callers cannot mutate shared state.
 */
import { isDeepStrictEqual } from "node:util";
import type { DiagnosticWorkerRetainedData } from "../../infra/diagnostic-process-types.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { estimateRetainedDataSize } from "../../infra/retained-data-size.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { registerListener } from "../../shared/listeners.js";
import { cloneAuthProfileStore } from "./clone.js";
import { observeCanonicalAuthProfileCredentials } from "./credential-observation.js";
import { noteAuthProfileFileWrite, readAuthProfileDatabaseIdentity } from "./file-state.js";
import {
  getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath,
  recordRuntimeAuthProfileStorePersistedMutation,
  resolveRuntimeStoreKey,
} from "./mutation-lineage.js";
import { captureAuthProfileOwnerScope, prepareSharedAuthStoreOwnership } from "./path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import { removePersonalAuthProfileReferences } from "./runtime-external-profile-references.js";
import { createRuntimeAuthProfileFileObservation } from "./runtime-file-observation.js";
import {
  clearAllRuntimeAuthMaterializations,
  clearRuntimeAuthMaterializationsAtDatabasePath,
} from "./runtime-materializations.js";
import { runtimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import {
  captureRuntimeAuthProfileLegacyCandidates,
  cloneRuntimeAuthProfileLegacyCandidates,
  captureRuntimeAuthSharedOwner,
  cloneRuntimeAuthSharedOwner,
  runtimeAuthProfileSnapshotSharesOwner,
  runtimeAuthSharedOwnerRebound,
  resolveRuntimeAuthSharedOwnerPath,
  classifyRuntimeAuthProfileSnapshotChange,
  type RuntimeAuthSharedOwner,
  type RuntimeAuthProfileLegacyCandidates,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
} from "./runtime-snapshot-owner.js";
import {
  createRuntimeAuthProfileSnapshotSelection,
  prepareRuntimeAuthProfileSharedCredentialSnapshots,
  prepareRuntimeAuthProfileSharedOwnerHandoff,
  sharedMutationAffectsSnapshot,
  type OwnedRuntimeSnapshot,
  type SharedAuthProfileStoreMutation,
} from "./runtime-snapshot-selection.js";
import { registerFreshSharedAuthStoreHandoff } from "./shared-store-bootstrap.js";
import { closeAuthProfileReadPool } from "./sqlite.js";
import type {
  AuthProfileStore,
  AuthProfileStoreOwner,
  PreparedAuthProfileStoreOwner,
  RuntimeAuthProfileStore,
} from "./types.js";

const runtimeAuthStoreSnapshots = new Map<string, OwnedRuntimeSnapshot>();

/** Anonymous store sizes only; do not materialize or clone credentials for diagnostics. */
export function measureRuntimeAuthProfileStores(): DiagnosticWorkerRetainedData[] {
  return [...runtimeAuthStoreSnapshots.values()].map(({ store }) =>
    Object.assign(estimateRetainedDataSize([store]), {
      structure: "catalog-auth" as const,
      entries: 1,
      accounts: Object.keys(store.profiles).length,
      providers: new Set(Object.values(store.profiles).map((profile) => profile.provider)).size,
    }),
  );
}

export const {
  invalidateRuntimeAuthProfileStoreSnapshotsForOwner,
  createPreparedRuntimeAuthProfileUsageReader,
  getRuntimeAuthProfileStoreSnapshotCore,
  getRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  getPreparedRuntimeAuthProfileStoreSnapshotCore,
  hasRuntimeAuthProfileStoreSource,
  hasAnyRuntimeAuthProfileStoreSource,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  listOwnedRuntimeAuthProfileStoreSnapshots,
  listRuntimeAuthProfileStoreSnapshotsForSharedOwner,
} = createRuntimeAuthProfileSnapshotSelection(
  runtimeAuthStoreSnapshots,
  clearRuntimeAuthProfileStoreSnapshotAtDatabasePath,
);

type RuntimeAuthProfileStoreMutationListener = (event: {
  agentDir?: string;
  affectsInheritedStores: boolean;
  profileSetChanged: boolean;
  availabilityOnly: boolean;
}) => void;
const runtimeAuthStoreMutationListeners = new Set<RuntimeAuthProfileStoreMutationListener>();
let pendingSnapshotNotifications: Array<() => void> | undefined;
let runtimeAuthStoreCredentialsRevision = 0;
let runtimeAuthStoreSnapshotsRevision = 0;
// Per-store generations isolate rollback ownership; the global counter remains
// the deletion generation for keys no longer present in this map.
const runtimeAuthStoreSnapshotRevisions = new Map<string, number>();
const runtimeAuthStoreDeletedSnapshotRevisions = new Map<string, number>();
let runtimeAuthStoreMetadataRevision = 0;
const runtimeAuthStoreMetadataRevisions = new Map<string, number>();
let runtimeAuthStoreCatalogRevision = 0;
const runtimeAuthStoreCatalogRevisions = new Map<string, number>();

const runtimeAuthFileObservation = createRuntimeAuthProfileFileObservation({
  snapshots: runtimeAuthStoreSnapshots,
  rowsCache: runtimeAuthProfileRowsCache,
  invalidatePaths: invalidateExternalAuthPaths,
});
export const {
  recordRuntimeAuthProfilePersistedStore,
  refreshRuntimeAuthProfileStoreSources,
  registerRuntimeAuthProfileExternalRefresh,
} = runtimeAuthFileObservation;

function invalidateExternalAuthPaths(
  paths: readonly string[],
  isCurrent?: (databasePath: string) => boolean,
): void {
  for (const databasePath of paths) {
    const entry = runtimeAuthStoreSnapshots.get(databasePath);
    const shared = [...runtimeAuthStoreSnapshots.values()].find(
      ({ owner }) => owner.kind === "resolved" && owner.sharedDatabasePath === databasePath,
    );
    if (!isCurrent) {
      runtimeAuthProfileRowsCache.clear(databasePath);
    }
    if (shared?.owner.kind === "resolved") {
      invalidateRuntimeAuthProfileStoreSnapshotsForOwner(
        { databasePath, ...shared.owner },
        isCurrent,
      );
    } else if (entry?.owner.kind === "resolved") {
      invalidateRuntimeAuthProfileStoreSnapshotsForOwner(
        { databasePath, ...entry.owner },
        isCurrent,
      );
    } else if (!isCurrent || isCurrent(databasePath)) {
      clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(databasePath);
    }
  }
}

registerFreshSharedAuthStoreHandoff((handoff) => {
  if (!handoff.sourceStillCurrent) {
    invalidateRuntimeAuthProfileStoreSnapshotsForOwner({
      databasePath: handoff.previousSharedDatabasePath,
      sharedDatabasePath: handoff.previousSharedDatabasePath,
      location: "legacy-main",
    });
    return;
  }
  const entries = prepareRuntimeAuthProfileSharedOwnerHandoff(
    listOwnedRuntimeAuthProfileStoreSnapshots(),
    handoff,
  );
  if (entries) {
    replaceOwnedRuntimeAuthProfileStoreSnapshots(entries);
  }
});

export {
  prepareRuntimeAuthProfileStoreSnapshots,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
} from "./runtime-snapshot-owner.js";

function recordDeletedSnapshotRevision(key: string): void {
  runtimeAuthStoreSnapshotRevisions.delete(key);
  runtimeAuthStoreDeletedSnapshotRevisions.delete(key);
  runtimeAuthStoreDeletedSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
  pruneMapToMaxSize(runtimeAuthStoreDeletedSnapshotRevisions, 256);
}

function advanceRuntimeAuthStoreMetadataRevision(key: string, availabilityOnly = false): void {
  if (!availabilityOnly) {
    runtimeAuthStoreCatalogRevision += 1;
    runtimeAuthStoreCatalogRevisions.delete(key);
    runtimeAuthStoreCatalogRevisions.set(key, runtimeAuthStoreCatalogRevision);
    pruneMapToMaxSize(runtimeAuthStoreCatalogRevisions, 256);
  }
  runtimeAuthStoreMetadataRevision += 1;
  runtimeAuthStoreMetadataRevisions.delete(key);
  runtimeAuthStoreMetadataRevisions.set(key, runtimeAuthStoreMetadataRevision);
  // Keep unpublished and deleted owners fenced without retaining them indefinitely.
  pruneMapToMaxSize(runtimeAuthStoreMetadataRevisions, 256);
}

function recordMetadataRevision(
  key: string,
  previous: OwnedRuntimeSnapshot | undefined,
  next: OwnedRuntimeSnapshot | undefined,
) {
  const change = classifyRuntimeAuthProfileSnapshotChange(previous, next);
  if (change !== "unchanged") {
    advanceRuntimeAuthStoreMetadataRevision(key, change === "availability");
  }
  return change;
}

function recordChangedSnapshotRevisions(next: ReadonlyMap<string, OwnedRuntimeSnapshot>) {
  const keys = new Set([...runtimeAuthStoreSnapshots.keys(), ...next.keys()]);
  const mutations: Array<{
    agentDir?: string;
    profileSetChanged: boolean;
    availabilityOnly: boolean;
  }> = [];
  for (const key of keys) {
    const previous = runtimeAuthStoreSnapshots.get(key);
    const candidate = next.get(key);
    if (isDeepStrictEqual(previous, candidate)) {
      continue;
    }
    const change = recordMetadataRevision(key, previous, candidate);
    if (change !== "unchanged") {
      const shared = [previous, candidate].some(
        (entry) =>
          entry &&
          (["state-db", "legacy-main"] as const).some(
            (location) => resolveRuntimeAuthSharedOwnerPath(entry.owner, location) === key,
          ),
      );
      mutations.push({
        agentDir: shared ? undefined : path.dirname(key),
        profileSetChanged: authProfileSetChanged(previous?.store, candidate?.store),
        availabilityOnly: change === "availability",
      });
    }
    runtimeAuthStoreSnapshotsRevision += 1;
    if (next.has(key)) {
      runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
      runtimeAuthStoreDeletedSnapshotRevisions.delete(key);
    } else {
      closeAuthProfileReadPool({ kind: "database", databasePath: key });
      recordDeletedSnapshotRevision(key);
    }
  }
  return mutations;
}

function notifyRuntimeAuthStoreMutation(
  agentDir?: string,
  profileSetChanged = false,
  availabilityOnly = false,
): void {
  const event = {
    ...(agentDir ? { agentDir } : {}),
    affectsInheritedStores: agentDir === undefined,
    profileSetChanged,
    availabilityOnly,
  };
  const notify = () => {
    for (const listener of runtimeAuthStoreMutationListeners) {
      listener(event);
    }
  };
  if (pendingSnapshotNotifications) {
    pendingSnapshotNotifications.push(notify);
  } else {
    notify();
  }
}

function authProfilesChanged(
  previous: RuntimeAuthProfileStore | undefined,
  next: RuntimeAuthProfileStore | undefined,
): boolean {
  return !isDeepStrictEqual(previous?.profiles ?? {}, next?.profiles ?? {});
}

function authProfileSetChanged(
  previous: RuntimeAuthProfileStore | undefined,
  next: RuntimeAuthProfileStore | undefined,
): boolean {
  return !isDeepStrictEqual(
    Object.keys(previous?.profiles ?? {}).toSorted(),
    Object.keys(next?.profiles ?? {}).toSorted(),
  );
}

/** Observes credential, ownership, and availability changes, excluding usage bookkeeping. */
export function registerRuntimeAuthProfileStoreMutationListener(
  listener: RuntimeAuthProfileStoreMutationListener,
): () => void {
  return registerListener(runtimeAuthStoreMutationListeners, listener);
}

/** @deprecated Use replaceRuntimeAuthProfileStoreSnapshotsAsync. Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ databasePath?: string; agentDir?: string; store: AuthProfileStore }>,
): void {
  warnPluginSdkDeprecation({
    family: "auth-profiles",
    method: "replaceRuntimeAuthProfileStoreSnapshots",
    replacement: "replaceRuntimeAuthProfileStoreSnapshotsAsync",
  });
  if (entries.some((entry) => !entry.databasePath && !entry.agentDir)) {
    prepareSharedAuthStoreOwnershipForNative();
  }
  replaceRuntimeAuthProfileStoreSnapshotEntries(entries);
}

/** Resolve a default owner off-thread before publishing the supplied snapshot facts. */
export async function replaceRuntimeAuthProfileStoreSnapshotsAsync(
  entries: Array<{ databasePath?: string; agentDir?: string; store: AuthProfileStore }>,
): Promise<void> {
  if (entries.some((entry) => !entry.databasePath && !entry.agentDir)) {
    await prepareSharedAuthStoreOwnership();
  }
  replaceRuntimeAuthProfileStoreSnapshotEntries(entries);
}

function replaceRuntimeAuthProfileStoreSnapshotEntries(
  entries: Array<{ databasePath?: string; agentDir?: string; store: AuthProfileStore }>,
): void {
  const prepared = entries.map((entry): OwnedRuntimeAuthProfileStoreSnapshotEntry => {
    // Enumeration already owns the canonical key; do not reconstruct it from a projected directory.
    const databasePath = entry.databasePath ?? resolveRuntimeStoreKey(entry.agentDir);
    return {
      databasePath,
      agentDir: path.dirname(databasePath),
      store: entry.store,
      owner: runtimeAuthStoreSnapshots.get(databasePath)?.owner ?? {
        kind: "unresolved",
        scope: captureAuthProfileOwnerScope(),
      },
      legacyCandidates:
        runtimeAuthStoreSnapshots.get(databasePath)?.legacyCandidates ??
        captureRuntimeAuthProfileLegacyCandidates(
          entry.agentDir ?? (entry.databasePath ? path.dirname(databasePath) : undefined),
        ),
    };
  });
  replaceOwnedRuntimeAuthProfileStoreSnapshots(prepared);
}

export function replaceOwnedRuntimeAuthProfileStoreSnapshots(
  entries: OwnedRuntimeAuthProfileStoreSnapshotEntry[],
): void {
  const sharedEntries = entries.map((entry) => ({
    ...entry,
    store: removePersonalAuthProfileReferences(entry.store),
  }));
  for (const entry of sharedEntries) {
    readAuthProfileDatabaseIdentity(entry.databasePath);
    if (entry.owner.kind === "resolved") {
      readAuthProfileDatabaseIdentity(entry.owner.sharedDatabasePath);
    }
  }
  const next = new Map(
    sharedEntries.map(
      ({ databasePath, store, owner, legacyCandidates }) =>
        [
          databasePath,
          {
            store: cloneAuthProfileStore(store),
            owner: cloneRuntimeAuthSharedOwner(owner),
            legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(legacyCandidates),
          },
        ] as const,
    ),
  );
  // Cold producer facts are enough to fence stale preparation; do not open SQLite
  // merely to avoid conservative invalidation for an irrelevant relocation.
  const reboundKeys = new Set(
    sharedEntries
      .filter((entry) => {
        const previous = runtimeAuthStoreSnapshots.get(entry.databasePath);
        return previous && runtimeAuthSharedOwnerRebound(previous.owner, entry.owner);
      })
      .map((entry) => entry.databasePath),
  );
  const keys = new Set([...runtimeAuthStoreSnapshots.keys(), ...next.keys()]);
  const credentialsChanged =
    reboundKeys.size > 0 ||
    [...keys].some((key) =>
      authProfilesChanged(runtimeAuthStoreSnapshots.get(key)?.store, next.get(key)?.store),
    );
  if (credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  for (const key of keys) {
    if (
      reboundKeys.has(key) ||
      authProfilesChanged(runtimeAuthStoreSnapshots.get(key)?.store, next.get(key)?.store)
    ) {
      clearRuntimeAuthMaterializationsAtDatabasePath(key);
    }
  }
  const mutations = recordChangedSnapshotRevisions(next);
  runtimeAuthStoreSnapshots.clear();
  for (const [key, entry] of next) {
    runtimeAuthStoreSnapshots.set(key, entry);
  }
  // Publishing resolved credentials does not change their captured persisted rows.
  const sourcePaths = new Set<string>();
  for (const entry of sharedEntries) {
    sourcePaths.add(entry.databasePath);
    if (entry.owner.kind === "resolved") {
      sourcePaths.add(entry.owner.sharedDatabasePath);
    }
  }
  runtimeAuthProfileRowsCache.publishSnapshots(sourcePaths);
  // Publish the complete roster before listeners refresh any changed local or inherited owner.
  if (mutations.some(({ agentDir }) => agentDir === undefined)) {
    notifyRuntimeAuthStoreMutation(
      undefined,
      mutations.some(({ profileSetChanged }) => profileSetChanged),
      mutations.every(({ availabilityOnly }) => availabilityOnly),
    );
  } else {
    for (const { agentDir, profileSetChanged, availabilityOnly } of mutations) {
      notifyRuntimeAuthStoreMutation(agentDir, profileSetChanged, availabilityOnly);
    }
  }
}

/** Clears all runtime auth profile snapshots. */
export function clearRuntimeAuthProfileStoreSnapshots(): void {
  runtimeAuthFileObservation.reset();
  closeAuthProfileReadPool();
  const snapshotsChanged = runtimeAuthStoreSnapshots.size > 0;
  const credentialsChanged = [...runtimeAuthStoreSnapshots.values()].some(
    ({ store }) => Object.keys(store.profiles).length > 0,
  );
  if (credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  runtimeAuthStoreSnapshotsRevision += 1;
  runtimeAuthProfileRowsCache.clear();
  // Explicit lifecycle clears also fence in-flight reads without a published snapshot.
  runtimeAuthStoreMetadataRevision += 1;
  runtimeAuthStoreCatalogRevision += 1;
  runtimeAuthStoreCatalogRevisions.clear();
  runtimeAuthStoreSnapshots.clear();
  clearAllRuntimeAuthMaterializations();
  runtimeAuthStoreSnapshotRevisions.clear();
  runtimeAuthStoreDeletedSnapshotRevisions.clear();
  runtimeAuthStoreMetadataRevisions.clear();
  if (snapshotsChanged) {
    notifyRuntimeAuthStoreMutation(undefined, credentialsChanged);
  }
}

/** Clears one runtime auth-profile snapshot without disturbing other active agents. */
export function clearRuntimeAuthProfileStoreSnapshotCore(agentDir?: string): boolean {
  return clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
    resolveRuntimeStoreKey(agentDir),
    agentDir,
  );
}

export function clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  key: string,
  agentDir?: string,
): boolean {
  closeAuthProfileReadPool({ kind: "database", databasePath: key });
  runtimeAuthProfileRowsCache.invalidateRows(key);
  const store = runtimeAuthStoreSnapshots.get(key)?.store;
  if (!store) {
    advanceRuntimeAuthStoreMetadataRevision(key);
    runtimeAuthStoreSnapshotsRevision += 1;
    recordDeletedSnapshotRevision(key);
    return false;
  }
  if (Object.keys(store.profiles).length > 0) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  runtimeAuthStoreSnapshotsRevision += 1;
  recordMetadataRevision(key, runtimeAuthStoreSnapshots.get(key), undefined);
  runtimeAuthStoreSnapshots.delete(key);
  clearRuntimeAuthMaterializationsAtDatabasePath(key);
  recordDeletedSnapshotRevision(key);
  notifyRuntimeAuthStoreMutation(agentDir, Object.keys(store.profiles).length > 0);
  return true;
}

/** Inputs are detached at public boundaries; private publications retain owned immutable facts. */
function setRuntimeAuthProfileStoreSnapshotAtKey(
  store: RuntimeAuthProfileStore,
  key: string,
  agentDir: string | undefined,
  owner: RuntimeAuthSharedOwner,
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates,
): void {
  const previous = runtimeAuthStoreSnapshots.get(key);
  const credentialsChanged = authProfilesChanged(previous?.store, store);
  const sharedOwnerRebound = previous && runtimeAuthSharedOwnerRebound(previous.owner, owner);
  if (credentialsChanged || sharedOwnerRebound) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  const previousStore = previous?.store;
  const profileSetChanged = credentialsChanged && authProfileSetChanged(previousStore, store);
  if (sharedOwnerRebound || credentialsChanged) {
    clearRuntimeAuthMaterializationsAtDatabasePath(key);
  }
  const changedMetadata = recordMetadataRevision(key, previous, { store, owner, legacyCandidates });
  const snapshotChanged =
    changedMetadata !== "unchanged" || !isDeepStrictEqual(previousStore, store);
  if (snapshotChanged) {
    runtimeAuthStoreSnapshotsRevision += 1;
    runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
    runtimeAuthStoreDeletedSnapshotRevisions.delete(key);
  }
  runtimeAuthStoreSnapshots.set(key, {
    store,
    owner,
    legacyCandidates,
  });
  if (changedMetadata !== "unchanged") {
    notifyRuntimeAuthStoreMutation(agentDir, profileSetChanged, changedMetadata === "availability");
  }
}

/** Stores a cloned runtime auth profile snapshot for an agent dir. */
export function setRuntimeAuthProfileStoreSnapshot(
  store: RuntimeAuthProfileStore,
  agentDir?: string,
): void {
  setRuntimeAuthProfileStoreSnapshotAtKey(
    cloneAuthProfileStore(removePersonalAuthProfileReferences(store)),
    resolveRuntimeStoreKey(agentDir),
    agentDir,
    captureRuntimeAuthSharedOwner(),
    captureRuntimeAuthProfileLegacyCandidates(agentDir),
  );
}

/** Restore the captured runtime owner independently of the persistence transaction. */
export function restoreOwnedRuntimeAuthProfileStoreSnapshot(
  entry: OwnedRuntimeAuthProfileStoreSnapshotEntry,
  agentDir?: string,
): void {
  setRuntimeAuthProfileStoreSnapshotAtKey(
    cloneAuthProfileStore(removePersonalAuthProfileReferences(entry.store)),
    entry.databasePath,
    agentDir,
    cloneRuntimeAuthSharedOwner(entry.owner),
    cloneRuntimeAuthProfileLegacyCandidates(entry.legacyCandidates),
  );
}

/** Materialization changes contents, not the existing producer's shared ownership. */
export function updateRuntimeAuthProfileStoreSnapshot(
  store: RuntimeAuthProfileStore,
  agentDir?: string,
): void {
  const key = resolveRuntimeStoreKey(agentDir);
  const owner = runtimeAuthStoreSnapshots.get(key)?.owner ?? captureRuntimeAuthSharedOwner();
  setRuntimeAuthProfileStoreSnapshotAtKey(
    cloneAuthProfileStore(removePersonalAuthProfileReferences(store)),
    key,
    agentDir,
    owner,
    runtimeAuthStoreSnapshots.get(key)?.legacyCandidates ??
      captureRuntimeAuthProfileLegacyCandidates(agentDir),
  );
}

/** Stores a cloned snapshot under an already resolved canonical database owner. */
export function setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  store: RuntimeAuthProfileStore,
  databasePath: string,
  agentDir: string | undefined,
  owner: AuthProfileStoreOwner | PreparedAuthProfileStoreOwner,
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates,
): void {
  const existing = runtimeAuthStoreSnapshots.get(databasePath);
  const candidates =
    "env" in owner
      ? captureRuntimeAuthProfileLegacyCandidates(
          databasePath === owner.sharedDatabasePath ? undefined : agentDir,
          owner.env,
        )
      : (legacyCandidates ??
        (existing && runtimeAuthProfileSnapshotSharesOwner(existing.owner, owner)
          ? existing.legacyCandidates
          : undefined));
  setRuntimeAuthProfileStoreSnapshotAtKey(
    cloneAuthProfileStore(removePersonalAuthProfileReferences(store)),
    databasePath,
    agentDir,
    {
      kind: "resolved",
      sharedDatabasePath: owner.sharedDatabasePath,
      location: owner.location,
    },
    cloneRuntimeAuthProfileLegacyCandidates(candidates),
  );
}

/**
 * Invalidates prepared credential ownership after a persisted owner-store write.
 * Main-store credentials are inherited by custom-agent snapshots, so those
 * derived snapshots must be dropped even when no exact main snapshot exists.
 * State-only saves refresh them in the publisher without changing credential ownership.
 */
export function noteRuntimeAuthProfileStorePersistedMutation(
  agentDir: string | undefined,
  mutation: SharedAuthProfileStoreMutation,
  owner?: AuthProfileStoreOwner,
  prepared?: ReadonlyMap<string, OwnedRuntimeSnapshot>,
  persisted?: { store: AuthProfileStore | null; env: NodeJS.ProcessEnv },
): number {
  const ownerKey = owner?.databasePath ?? resolveRuntimeStoreKey(agentDir);
  noteAuthProfileFileWrite(ownerKey);
  if (!mutation.credentialsChanged && !mutation.profileSetChanged && !mutation.stateChanged) {
    return getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(ownerKey);
  }
  const changedProfileIds = [...mutation.profileIds];
  if (mutation.credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  runtimeAuthProfileRowsCache.invalidateRows(ownerKey);
  if (mutation.selectionChanged) {
    // Fence readers now; snapshot publication classifies catalog identity versus availability.
    advanceRuntimeAuthStoreMetadataRevision(ownerKey, true);
  }
  if (mutation.credentialsChanged || mutation.profileSetChanged) {
    clearRuntimeAuthMaterializationsAtDatabasePath(ownerKey);
  }
  recordRuntimeAuthProfileStorePersistedMutation(ownerKey, {
    ...mutation,
    profileIds: changedProfileIds,
  });
  if (persisted) {
    recordRuntimeAuthProfilePersistedStore(ownerKey, persisted.store);
  } else {
    runtimeAuthProfileRowsCache.rebase(ownerKey);
  }
  const revision = getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(ownerKey);
  const mainKey = owner?.sharedDatabasePath ?? resolveRuntimeStoreKey(undefined);
  if (ownerKey === mainKey && (mutation.credentialsChanged || mutation.profileSetChanged)) {
    const sharedOwner = owner ?? captureRuntimeAuthSharedOwner();
    const affected = sharedMutationAffectsSnapshot({ ...mutation, profileIds: changedProfileIds });
    for (const [key, entry] of runtimeAuthStoreSnapshots) {
      if (
        key !== mainKey &&
        !prepared?.has(key) &&
        runtimeAuthProfileSnapshotSharesOwner(entry.owner, sharedOwner) &&
        affected(entry.store)
      ) {
        runtimeAuthStoreSnapshotsRevision += 1;
        recordMetadataRevision(key, entry, undefined);
        runtimeAuthStoreSnapshots.delete(key);
        recordDeletedSnapshotRevision(key);
      }
    }
  }
  if (mutation.credentialsChanged || mutation.profileSetChanged) {
    notifyRuntimeAuthStoreMutation(agentDir, mutation.profileSetChanged === true);
  }
  return revision;
}

/** Install one committed shared generation before listeners can observe any affected owner. */
export function publishRuntimeAuthProfileSharedCredentialMutation(
  owner: PreparedAuthProfileStoreOwner,
  committedStore: AuthProfileStore,
  mutation: Parameters<typeof noteRuntimeAuthProfileStorePersistedMutation>[1],
) {
  if (
    owner.databasePath !== owner.sharedDatabasePath ||
    mutation.stateChanged ||
    mutation.profileSetChanged
  ) {
    return undefined;
  }
  const committed = cloneAuthProfileStore(committedStore);
  observeCanonicalAuthProfileCredentials(owner.databasePath, committed.profiles);
  const profileIds = [...mutation.profileIds];
  const { prepared, deferred } = prepareRuntimeAuthProfileSharedCredentialSnapshots(
    runtimeAuthStoreSnapshots,
    owner,
    committed,
    { ...mutation, profileIds },
  );
  const previousNotifications = pendingSnapshotNotifications;
  const notifications: Array<() => void> = [];
  pendingSnapshotNotifications = notifications;
  let publication;
  try {
    const revision = noteRuntimeAuthProfileStorePersistedMutation(
      undefined,
      { ...mutation, profileIds },
      owner,
      prepared,
      { store: committedStore, env: owner.env },
    );
    for (const [key, entry] of prepared) {
      setRuntimeAuthProfileStoreSnapshotAtKey(
        entry.store,
        key,
        key === owner.databasePath ? undefined : path.dirname(key),
        entry.owner,
        entry.legacyCandidates,
      );
    }
    // The shared snapshot itself is not evicted by ordinary derived invalidation.
    if (deferred.some((entry) => entry.databasePath === owner.databasePath)) {
      clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath);
    }
    publication = {
      entries: deferred,
      revision,
      snapshots: new Map(
        deferred.map((entry) => [
          entry.databasePath,
          getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(entry.databasePath),
        ]),
      ),
      mutations: new Map(
        deferred.map((entry) => [
          entry.databasePath,
          getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(entry.databasePath),
        ]),
      ),
    };
  } finally {
    pendingSnapshotNotifications = previousNotifications;
    if (previousNotifications) {
      previousNotifications.push(...notifications);
    } else {
      for (const notify of notifications) {
        notify();
      }
    }
  }
  return publication;
}

/** Stable token for credential ownership without coupling to usage bookkeeping. */
export const getRuntimeAuthProfileStoreCredentialsRevision = () =>
  runtimeAuthStoreCredentialsRevision;

/** Metadata generation; full snapshot revisions separately fence bookkeeping and rollback. */
export function getRuntimeAuthProfileStoreMetadataRevision(agentDir?: string): number {
  return (
    runtimeAuthStoreMetadataRevisions.get(resolveRuntimeStoreKey(agentDir)) ??
    runtimeAuthStoreMetadataRevision
  );
}

/** Catalog identity excludes live cooldowns but includes credentials, order, and ownership. */
export function getRuntimeAuthProfileStoreCatalogRevision(agentDir?: string): number {
  return (
    runtimeAuthStoreCatalogRevisions.get(resolveRuntimeStoreKey(agentDir)) ??
    runtimeAuthStoreCatalogRevision
  );
}

export function getRuntimeAuthProfileStoreSnapshotsRevision(): number {
  return runtimeAuthStoreSnapshotsRevision;
}

/** Process-local generation for one exact runtime snapshot rollback owner. */
export function getRuntimeAuthProfileStoreSnapshotRevision(agentDir?: string): number {
  return getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(resolveRuntimeStoreKey(agentDir));
}

/** Process-local generation for an already resolved canonical snapshot owner. */
export function getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(
  databasePath: string,
): number {
  return (
    runtimeAuthStoreSnapshotRevisions.get(databasePath) ??
    runtimeAuthStoreDeletedSnapshotRevisions.get(databasePath) ??
    runtimeAuthStoreSnapshotsRevision
  );
}
