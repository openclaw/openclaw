import path from "node:path";
/**
 * Process-local auth profile snapshots used by prepared runtimes and tests.
 * Snapshots are cloned at boundaries so callers cannot mutate shared state.
 */
import { isDeepStrictEqual } from "node:util";
import { registerListener } from "../../shared/listeners.js";
import { cloneAuthProfileStore } from "./clone.js";
import {
  observeCachedCanonicalAuthProfileCredentials,
  observeCanonicalAuthProfileCredentials,
} from "./credential-observation.js";
import {
  getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath,
  recordRuntimeAuthProfileStorePersistedMutation,
  resolveRuntimeStoreKey,
} from "./mutation-lineage.js";
import { captureAuthProfileOwnerScope } from "./path-resolve.js";
import { mergeAuthProfileStores } from "./persisted.js";
import { removePersonalAuthProfileReferences } from "./runtime-external-profile-references.js";
import {
  clearAllRuntimeAuthMaterializations,
  clearRuntimeAuthMaterializationsAtDatabasePath,
} from "./runtime-materializations.js";
import { createRuntimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import {
  captureRuntimeAuthProfileLegacyCandidates,
  cloneRuntimeAuthProfileLegacyCandidates,
  captureRuntimeAuthSharedOwner,
  cloneRuntimeAuthSharedOwner,
  runtimeAuthProfileSnapshotSharesOwner,
  runtimeAuthSharedOwnerRebound,
  resolveRuntimeAuthSharedOwnerPath,
  runtimeAuthMetadataState,
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

export const {
  invalidateRuntimeAuthProfileStoreSnapshotsForOwner,
  createPreparedRuntimeAuthProfileUsageReader,
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
let runtimeAuthStoreMetadataRevisionFloor = 0;

export const runtimeAuthProfileRowsCache = createRuntimeAuthProfileRowsCache(
  (databasePath) =>
    `${getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(databasePath)}:${getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(databasePath)}`,
);

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

function advanceRuntimeAuthStoreSnapshotsRevision(): void {
  // Readers must close before consumers can observe the new snapshot generation.
  closeAuthProfileReadPool();
  runtimeAuthStoreSnapshotsRevision += 1;
}

function recordDeletedSnapshotRevision(key: string): void {
  runtimeAuthStoreSnapshotRevisions.delete(key);
  runtimeAuthStoreDeletedSnapshotRevisions.delete(key);
  runtimeAuthStoreDeletedSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
  while (runtimeAuthStoreDeletedSnapshotRevisions.size > 256) {
    runtimeAuthStoreDeletedSnapshotRevisions.delete(
      runtimeAuthStoreDeletedSnapshotRevisions.keys().next().value!,
    );
  }
}

function snapshotMetadataState(entry: OwnedRuntimeSnapshot | undefined) {
  return (
    entry && {
      state: runtimeAuthMetadataState(entry.store),
      owner: entry.owner,
      legacyCandidates: entry.legacyCandidates,
    }
  );
}

function advanceRuntimeAuthStoreMetadataRevision(key: string): void {
  runtimeAuthStoreMetadataRevision += 1;
  runtimeAuthStoreMetadataRevisions.delete(key);
  runtimeAuthStoreMetadataRevisions.set(key, runtimeAuthStoreMetadataRevision);
  // Keep unpublished and deleted owners fenced without retaining them indefinitely.
  while (runtimeAuthStoreMetadataRevisions.size > 256) {
    const [oldestKey, revision] = runtimeAuthStoreMetadataRevisions.entries().next().value!;
    runtimeAuthStoreMetadataRevisions.delete(oldestKey);
    runtimeAuthStoreMetadataRevisionFloor = Math.max(
      runtimeAuthStoreMetadataRevisionFloor,
      revision,
    );
  }
}

function recordMetadataRevision(
  key: string,
  previous: OwnedRuntimeSnapshot | undefined,
  next: OwnedRuntimeSnapshot | undefined,
): boolean {
  if (isDeepStrictEqual(snapshotMetadataState(previous), snapshotMetadataState(next))) {
    return false;
  }
  advanceRuntimeAuthStoreMetadataRevision(key);
  return true;
}

function recordChangedSnapshotRevisions(next: ReadonlyMap<string, OwnedRuntimeSnapshot>): boolean {
  const keys = new Set([...runtimeAuthStoreSnapshots.keys(), ...next.keys()]);
  let metadataChanged = false;
  for (const key of keys) {
    const previous = runtimeAuthStoreSnapshots.get(key);
    const candidate = next.get(key);
    if (isDeepStrictEqual(previous, candidate)) {
      continue;
    }
    metadataChanged = recordMetadataRevision(key, previous, candidate) || metadataChanged;
    advanceRuntimeAuthStoreSnapshotsRevision();
    if (next.has(key)) {
      runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
      runtimeAuthStoreDeletedSnapshotRevisions.delete(key);
    } else {
      recordDeletedSnapshotRevision(key);
    }
  }
  return metadataChanged;
}

function resolveRuntimeSnapshotEntryKey(entry: {
  databasePath?: string;
  agentDir?: string;
}): string {
  // Enumeration already owns the canonical key; never reconstruct it from a projected directory.
  return entry.databasePath ?? resolveRuntimeStoreKey(entry.agentDir);
}

function notifyRuntimeAuthStoreMutation(agentDir?: string, profileSetChanged = false): void {
  const event = {
    ...(agentDir ? { agentDir } : {}),
    affectsInheritedStores: agentDir === undefined,
    profileSetChanged,
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

/** Reads a cloned runtime auth profile store snapshot for an agent dir. */
export function getRuntimeAuthProfileStoreSnapshotCore(
  agentDir?: string,
): RuntimeAuthProfileStore | undefined {
  return getRuntimeAuthProfileStoreSnapshotAtDatabasePath(resolveRuntimeStoreKey(agentDir));
}

export function getRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  databasePath: string,
): RuntimeAuthProfileStore | undefined {
  const store = runtimeAuthStoreSnapshots.get(databasePath)?.store;
  if (store) {
    observeCachedCanonicalAuthProfileCredentials(store.profiles);
  }
  return store ? cloneAuthProfileStore(store) : undefined;
}

/**
 * Reads the effective prepared auth store without falling back to persisted storage.
 * Lifecycle consumers use this after auth publication so request paths never reopen SQLite.
 */
export function getPreparedRuntimeAuthProfileStoreSnapshotCore(
  agentDir?: string,
  inheritedAuthDir?: string,
  env?: NodeJS.ProcessEnv,
): RuntimeAuthProfileStore | undefined {
  const inheritedKey = resolveRuntimeStoreKey(inheritedAuthDir, env);
  const requestedKey = resolveRuntimeStoreKey(agentDir, env);
  const inherited = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(inheritedKey);
  if (requestedKey === inheritedKey) {
    return inherited;
  }
  const requested = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(requestedKey);
  // With no agent, the shared snapshot wins without merging the inherited store.
  if (agentDir && inherited && requested) {
    return mergeAuthProfileStores(inherited, requested, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }
  if (agentDir && !requested && inherited) {
    // The shared snapshot owns its order; this agent has no local override to reset.
    return { ...inherited, runtimeLocalOrderProviderIds: [] };
  }
  return requested ?? inherited;
}

/** Checks the owned profile keys without copying private credential data out of the owner. */
export function hasRuntimeAuthProfileStoreSource(
  agentDir?: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  const store = runtimeAuthStoreSnapshots.get(resolveRuntimeStoreKey(agentDir, env))?.store;
  return Boolean(store && Object.keys(store.profiles).length > 0);
}

/** Returns true when requested or main runtime snapshots contain profiles. */
export function hasAnyRuntimeAuthProfileStoreSource(agentDir?: string): boolean {
  return (
    hasRuntimeAuthProfileStoreSource(agentDir) ||
    (Boolean(agentDir) && hasRuntimeAuthProfileStoreSource())
  );
}

/** Replaces all runtime auth profile snapshots with cloned entries. */
export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ databasePath?: string; agentDir?: string; store: AuthProfileStore }>,
): void {
  const prepared = entries.map((entry): OwnedRuntimeAuthProfileStoreSnapshotEntry => {
    const databasePath = resolveRuntimeSnapshotEntryKey(entry);
    return {
      databasePath,
      agentDir: path.dirname(databasePath),
      store: cloneAuthProfileStore(entry.store),
      owner: cloneRuntimeAuthSharedOwner(
        runtimeAuthStoreSnapshots.get(databasePath)?.owner ?? {
          kind: "unresolved",
          scope: captureAuthProfileOwnerScope(),
        },
      ),
      legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(
        runtimeAuthStoreSnapshots.get(databasePath)?.legacyCandidates ??
          captureRuntimeAuthProfileLegacyCandidates(
            entry.agentDir ?? (entry.databasePath ? path.dirname(databasePath) : undefined),
          ),
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
  const next = new Map(
    sharedEntries.map(
      ({ databasePath, store, owner, legacyCandidates }) =>
        [databasePath, { store, owner, legacyCandidates }] as const,
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
  const profileSetChanged = [...keys].some((key) =>
    authProfileSetChanged(runtimeAuthStoreSnapshots.get(key)?.store, next.get(key)?.store),
  );
  for (const key of keys) {
    if (
      reboundKeys.has(key) ||
      authProfilesChanged(runtimeAuthStoreSnapshots.get(key)?.store, next.get(key)?.store)
    ) {
      clearRuntimeAuthMaterializationsAtDatabasePath(key);
    }
  }
  const metadataChanged = recordChangedSnapshotRevisions(next);
  const nextOwned = sharedEntries.map((entry) => {
    const key = resolveRuntimeSnapshotEntryKey(entry);
    return [
      key,
      {
        store: cloneAuthProfileStore(entry.store),
        owner: cloneRuntimeAuthSharedOwner(entry.owner),
        legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(entry.legacyCandidates),
      },
    ] as const;
  });
  runtimeAuthStoreSnapshots.clear();
  for (const [key, entry] of nextOwned) {
    runtimeAuthStoreSnapshots.set(key, entry);
  }
  if (metadataChanged) {
    notifyRuntimeAuthStoreMutation(undefined, profileSetChanged);
  }
}

/** Clears all runtime auth profile snapshots. */
export function clearRuntimeAuthProfileStoreSnapshots(): void {
  const snapshotsChanged = runtimeAuthStoreSnapshots.size > 0;
  const credentialsChanged = [...runtimeAuthStoreSnapshots.values()].some(
    ({ store }) => Object.keys(store.profiles).length > 0,
  );
  if (credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  advanceRuntimeAuthStoreSnapshotsRevision();
  runtimeAuthProfileRowsCache.clear();
  // Explicit lifecycle clears also fence in-flight reads without a published snapshot.
  runtimeAuthStoreMetadataRevision += 1;
  runtimeAuthStoreMetadataRevisionFloor = runtimeAuthStoreMetadataRevision;
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
  runtimeAuthProfileRowsCache.clear(key);
  const store = runtimeAuthStoreSnapshots.get(key)?.store;
  if (!store) {
    advanceRuntimeAuthStoreMetadataRevision(key);
    advanceRuntimeAuthStoreSnapshotsRevision();
    recordDeletedSnapshotRevision(key);
    return false;
  }
  if (Object.keys(store.profiles).length > 0) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  advanceRuntimeAuthStoreSnapshotsRevision();
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
  const snapshotChanged = changedMetadata || !isDeepStrictEqual(previousStore, store);
  if (snapshotChanged) {
    advanceRuntimeAuthStoreSnapshotsRevision();
    runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
    runtimeAuthStoreDeletedSnapshotRevisions.delete(key);
  }
  runtimeAuthStoreSnapshots.set(key, {
    store,
    owner,
    legacyCandidates,
  });
  if (changedMetadata) {
    notifyRuntimeAuthStoreMutation(agentDir, profileSetChanged);
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
): number {
  const ownerKey = owner?.databasePath ?? resolveRuntimeStoreKey(agentDir);
  if (!mutation.credentialsChanged && !mutation.profileSetChanged && !mutation.stateChanged) {
    return getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(ownerKey);
  }
  const changedProfileIds = [...mutation.profileIds];
  if (mutation.credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  runtimeAuthProfileRowsCache.clear(ownerKey);
  if (mutation.selectionChanged) {
    advanceRuntimeAuthStoreMetadataRevision(ownerKey);
  }
  if (mutation.credentialsChanged || mutation.profileSetChanged) {
    clearRuntimeAuthMaterializationsAtDatabasePath(ownerKey);
  }
  recordRuntimeAuthProfileStorePersistedMutation(ownerKey, {
    ...mutation,
    profileIds: changedProfileIds,
  });
  const revision = getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(ownerKey);
  const mainKey = owner?.sharedDatabasePath ?? resolveRuntimeStoreKey(undefined);
  if (ownerKey === mainKey && (mutation.credentialsChanged || mutation.profileSetChanged)) {
    let deletedDerivedSnapshot = false;
    const sharedOwner = owner ?? captureRuntimeAuthSharedOwner();
    const affected = sharedMutationAffectsSnapshot({ ...mutation, profileIds: changedProfileIds });
    for (const [key, entry] of runtimeAuthStoreSnapshots) {
      if (
        key !== mainKey &&
        !prepared?.has(key) &&
        runtimeAuthProfileSnapshotSharesOwner(entry.owner, sharedOwner) &&
        affected(entry.store)
      ) {
        if (!deletedDerivedSnapshot) {
          advanceRuntimeAuthStoreSnapshotsRevision();
        }
        recordMetadataRevision(key, entry, undefined);
        runtimeAuthStoreSnapshots.delete(key);
        recordDeletedSnapshotRevision(key);
        deletedDerivedSnapshot = true;
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
  owner: AuthProfileStoreOwner,
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
