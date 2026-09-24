import { mergeRuntimeExternalProfileReferences } from "./runtime-external-profile-references.js";
import {
  preserveResolvedSecretBackedCredentials,
  runtimeAuthProfileSnapshotSharesOwner,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
} from "./runtime-snapshot-owner.js";
import { setRuntimeAuthProfileStoreSnapshotAtDatabasePath } from "./runtime-snapshots.js";
import type { AuthProfileStoreOwner } from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

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
  if (!runtimeAuthProfileSnapshotSharesOwner(existing.owner, owner)) {
    // Resolved secrets and external profiles belong to their producer, not just a matching ref.
    setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
      refreshed,
      owner.databasePath,
      agentDir,
      owner,
      candidates,
    );
    return;
  }
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
  const rebuilt = mergeRuntimeExternalProfileReferences({
    next: materialized,
    existing: existing.store,
  });
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
    rebuilt,
    owner.databasePath,
    agentDir,
    owner,
    candidates,
  );
}
