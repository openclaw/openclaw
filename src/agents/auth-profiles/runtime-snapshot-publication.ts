import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { authProfilesLog } from "./constants.js";
import { mergeRuntimeExternalProfileReferences } from "./runtime-external-profile-references.js";
import {
  preserveResolvedSecretBackedCredentials,
  runtimeAuthProfileSnapshotSharesOwner,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
} from "./runtime-snapshot-owner.js";
import {
  clearRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath,
} from "./runtime-snapshots.js";
import type { AuthProfileDatabase } from "./sqlite.js";
import type { AuthProfileStore, AuthProfileStoreOwner } from "./types.js";

/** Publish canonical facts while retaining the current host's same-owner overlays. */
export function publishPreparedRuntimeAuthProfileStoreSnapshot(
  agentDir: string | undefined,
  existing: OwnedRuntimeAuthProfileStoreSnapshotEntry,
  owner: AuthProfileStoreOwner,
  refreshed: AuthProfileStore,
  options: {
    predecessor?: AuthProfileStore;
    candidates?: OwnedRuntimeAuthProfileStoreSnapshotEntry["legacyCandidates"];
  } = {},
): void {
  const { predecessor, candidates } = options;
  let rebuilt = refreshed;
  // Resolved secrets and external profiles belong to their producer, not just a matching ref.
  if (runtimeAuthProfileSnapshotSharesOwner(existing.owner, owner)) {
    const currentMaterialized = preserveResolvedSecretBackedCredentials({
      next: refreshed,
      existing: existing.store,
    });
    const materialized = predecessor
      ? preserveResolvedSecretBackedCredentials({
          next: currentMaterialized,
          existing: predecessor,
        })
      : currentMaterialized;
    rebuilt = mergeRuntimeExternalProfileReferences({
      next: materialized,
      existing: existing.store,
    });
  }
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
    rebuilt,
    owner.databasePath,
    agentDir,
    owner,
    candidates,
  );
}

export type RuntimeSnapshotPublication = {
  agentDir?: string;
  databasePath: string;
  publish: () => boolean;
};

export function publishRuntimeSnapshotsAfterCommit(
  publication: RuntimeSnapshotPublication,
): boolean {
  // A committed write can no longer roll back, so publication failure must
  // evict only the exact derived owner that could now be stale.
  try {
    return publication.publish();
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

export function deferRuntimeSnapshotsAfterCommit(
  database: AuthProfileDatabase,
  publication: RuntimeSnapshotPublication,
  publishWithoutTransaction = false,
): void {
  const publish = () => publishRuntimeSnapshotsAfterCommit(publication);
  if (!deferSqlitePostCommitPublication(database.db, publish) && publishWithoutTransaction) {
    publish();
  }
}
