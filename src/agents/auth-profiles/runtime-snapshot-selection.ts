import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cloneAuthProfileStore } from "./clone.js";
import { reportCommittedInlineAuthFailure } from "./constants.js";
import { observeCachedCanonicalAuthProfileCredentials } from "./credential-observation.js";
import { assertAuthProfileMigrationStateAtDatabasePath } from "./legacy-source-diagnostic.js";
import { resolveRuntimeStoreKey } from "./mutation-lineage.js";
import { buildPersistedAuthProfileSecretsStore, mergeAuthProfileStores } from "./persisted.js";
import {
  cloneRuntimeAuthProfileLegacyCandidates,
  cloneRuntimeAuthSharedOwner,
  runtimeAuthProfileSnapshotSharesOwner,
  runtimeAuthSharedOwnerRebound,
  replaceRuntimeAuthProfileStoreCredentials,
  updateRuntimeAuthProfileStoreInheritedCredentials,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
  type RuntimeAuthProfileLegacyCandidates,
  type RuntimeAuthSharedOwner,
} from "./runtime-snapshot-owner.js";
import type { AuthProfileStore, AuthProfileStoreOwner, RuntimeAuthProfileStore } from "./types.js";

export type OwnedRuntimeSnapshot = {
  store: RuntimeAuthProfileStore;
  owner: RuntimeAuthSharedOwner;
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates;
};

export type SharedAuthProfileStoreMutation = {
  credentialsChanged: boolean;
  profileSetChanged?: boolean;
  stateChanged: boolean;
  selectionChanged?: boolean;
  profileIds: Iterable<string>;
  oauthRefreshClaimIds?: ReadonlyMap<string, string | undefined>;
};

export function sharedMutationAffectsSnapshot(
  mutation?: SharedAuthProfileStoreMutation,
): (store: RuntimeAuthProfileStore) => boolean {
  if (!mutation || mutation.stateChanged) {
    return () => true;
  }
  if (!mutation.credentialsChanged && !mutation.profileSetChanged) {
    return () => false;
  }
  const changedProfileIds = [...mutation.profileIds];
  return (store) => {
    // Only canonical composition can exclude a reconciled-away local OAuth row.
    if (
      store.runtimeHasLocalOAuthProfiles !== false ||
      !store.runtimeLocalProfileIds ||
      changedProfileIds.length === 0
    ) {
      return true;
    }
    const localIds = new Set(store.runtimeLocalProfileIds);
    return changedProfileIds.some((id) => !localIds.has(id));
  };
}

function cloneOwnedRuntimeAuthProfileStoreSnapshot(
  databasePath: string,
  entry: OwnedRuntimeSnapshot,
): OwnedRuntimeAuthProfileStoreSnapshotEntry {
  return {
    databasePath,
    agentDir: path.dirname(databasePath),
    store: cloneAuthProfileStore(entry.store),
    owner: cloneRuntimeAuthSharedOwner(entry.owner),
    legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(entry.legacyCandidates),
  };
}

/** Borrow the snapshot owner's map; selection never retains or mutates credential state. */
export function createRuntimeAuthProfileSnapshotSelection(
  snapshots: ReadonlyMap<string, OwnedRuntimeSnapshot>,
  revision: (databasePath: string) => number,
  invalidate: (databasePath: string, agentDir?: string) => unknown,
) {
  /** Select producer-owned identities before copying any credential bodies. */
  function listRuntimeAuthProfileStoreSnapshotTargetsForSharedOwner(
    owner: AuthProfileStoreOwner,
    mutation?: SharedAuthProfileStoreMutation,
  ): Array<{ databasePath: string; agentDir: string; runtimeRevision: number }> {
    const affected = sharedMutationAffectsSnapshot(mutation);
    return Array.from(snapshots)
      .filter(
        ([databasePath, entry]) =>
          databasePath !== owner.sharedDatabasePath &&
          runtimeAuthProfileSnapshotSharesOwner(entry.owner, owner) &&
          affected(entry.store),
      )
      .map(([databasePath]) => ({
        databasePath,
        agentDir: path.dirname(databasePath),
        runtimeRevision: revision(databasePath),
      }));
  }
  /** Captures the published owners once; catalog reads refresh usage without opening storage. */
  function createPreparedRuntimeAuthProfileUsageReader(
    agentDir: string,
    inheritedAuthDir?: string,
  ): (store: AuthProfileStore) => AuthProfileStore {
    const requestedKey = resolveRuntimeStoreKey(agentDir);
    const requestedOwner = snapshots.get(requestedKey)?.owner;
    const inheritedKey = inheritedAuthDir
      ? resolveRuntimeStoreKey(inheritedAuthDir)
      : requestedOwner?.kind === "resolved"
        ? requestedOwner.sharedDatabasePath
        : requestedKey;
    const owners = [...new Set([inheritedKey, requestedKey])].flatMap((key) => {
      const entry = snapshots.get(key);
      return entry ? [{ key, owner: entry.owner }] : [];
    });
    return (store) => {
      const current = new Map<string, RuntimeAuthProfileStore>();
      for (const { key, owner } of owners) {
        const entry = snapshots.get(key);
        if (!entry || runtimeAuthSharedOwnerRebound(owner, entry.owner)) {
          return store;
        }
        current.set(key, entry.store);
      }
      const inherited = current.get(inheritedKey);
      const requested = current.get(requestedKey);
      const published =
        inherited && requested && inheritedKey !== requestedKey
          ? mergeAuthProfileStores(inherited, requested, {
              preserveBaseRuntimeExternalProfiles: true,
            })
          : (requested ?? inherited);
      if (!published) {
        return store;
      }
      // Compare existing descriptor identities without replacing worker-resolved secret literals.
      const workerProfiles = buildPersistedAuthProfileSecretsStore(store).profiles;
      const publishedProfiles = buildPersistedAuthProfileSecretsStore(published).profiles;
      let usageStats: AuthProfileStore["usageStats"];
      for (const [profileId, credential] of Object.entries(workerProfiles)) {
        if (!isDeepStrictEqual(credential, publishedProfiles[profileId])) {
          continue;
        }
        // A cleared local profile must not inherit a different owner's same-id block.
        const usageOwner =
          published.profiles[profileId] === requested?.profiles[profileId] ? requested : inherited;
        const usage = usageOwner?.usageStats?.[profileId];
        if (isDeepStrictEqual(store.usageStats?.[profileId], usage)) {
          continue;
        }
        usageStats ??= { ...store.usageStats };
        if (usage === undefined) {
          delete usageStats[profileId];
        } else {
          usageStats[profileId] = usage;
        }
      }
      return usageStats
        ? {
            ...store,
            usageStats: cloneAuthProfileStore({ version: store.version, profiles: {}, usageStats })
              .usageStats,
          }
        : store;
    };
  }

  return {
    /** Newer incremental views can still omit this write; discard matching owner views on failure. */
    invalidateRuntimeAuthProfileStoreSnapshotsForOwner: (owner: AuthProfileStoreOwner) => {
      const targets = [
        {
          databasePath: owner.databasePath,
          agentDir:
            owner.databasePath === owner.sharedDatabasePath
              ? undefined
              : path.dirname(owner.databasePath),
        },
        ...(owner.databasePath === owner.sharedDatabasePath
          ? listRuntimeAuthProfileStoreSnapshotTargetsForSharedOwner(owner)
          : []),
      ];
      for (const target of targets) {
        try {
          const entry = snapshots.get(target.databasePath);
          if (!entry || runtimeAuthProfileSnapshotSharesOwner(entry.owner, owner)) {
            invalidate(target.databasePath, target.agentDir);
          }
        } catch (error) {
          reportCommittedInlineAuthFailure("Auth snapshot invalidation observer failed", error);
        }
      }
    },
    createPreparedRuntimeAuthProfileUsageReader,
    getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath: (databasePath: string) => {
      const entry = snapshots.get(databasePath);
      if (entry) {
        observeCachedCanonicalAuthProfileCredentials(entry.store.profiles);
      }
      return entry && cloneOwnedRuntimeAuthProfileStoreSnapshot(databasePath, entry);
    },
    listOwnedRuntimeAuthProfileStoreSnapshots: () =>
      Array.from(snapshots, ([databasePath, entry]) =>
        cloneOwnedRuntimeAuthProfileStoreSnapshot(databasePath, entry),
      ),
    listRuntimeAuthProfileStoreSnapshotsForSharedOwner: (
      owner: AuthProfileStoreOwner,
      mutation?: SharedAuthProfileStoreMutation,
    ) =>
      listRuntimeAuthProfileStoreSnapshotTargetsForSharedOwner(owner, mutation).map(
        ({ databasePath }) =>
          cloneOwnedRuntimeAuthProfileStoreSnapshot(databasePath, snapshots.get(databasePath)!),
      ),
  };
}

/** Prepare replacements without publishing or recopying unchanged private snapshots. */
export function prepareRuntimeAuthProfileSharedCredentialSnapshots(
  snapshots: ReadonlyMap<string, OwnedRuntimeSnapshot>,
  owner: AuthProfileStoreOwner,
  committed: AuthProfileStore,
  mutation: SharedAuthProfileStoreMutation,
) {
  const profileIds = [...mutation.profileIds];
  const prepared = new Map<string, OwnedRuntimeSnapshot>();
  const deferred: OwnedRuntimeAuthProfileStoreSnapshotEntry[] = [];
  const affected = sharedMutationAffectsSnapshot({ ...mutation, profileIds });
  for (const [key, entry] of snapshots) {
    if (
      !runtimeAuthProfileSnapshotSharesOwner(entry.owner, owner) ||
      (key !== owner.databasePath && !affected(entry.store))
    ) {
      continue;
    }
    let store: RuntimeAuthProfileStore | undefined;
    try {
      assertAuthProfileMigrationStateAtDatabasePath(key);
      assertAuthProfileMigrationStateAtDatabasePath(owner.sharedDatabasePath);
      store =
        key === owner.databasePath
          ? replaceRuntimeAuthProfileStoreCredentials(entry.store, committed, profileIds)
          : updateRuntimeAuthProfileStoreInheritedCredentials(entry.store, committed, {
              ...mutation,
              profileIds,
            });
    } catch {
      // Canonical preparation reports the recorded refusal after stale facts are invalidated.
    }
    if (store) {
      prepared.set(key, { ...entry, store });
    } else {
      deferred.push(cloneOwnedRuntimeAuthProfileStoreSnapshot(key, entry));
    }
  }
  return { prepared, deferred };
}
