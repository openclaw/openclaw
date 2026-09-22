import path from "node:path";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { reportCommittedInlineAuthFailure } from "./constants.js";
import type { InlineAuthFailureReceipt } from "./inline-usage-kernel.js";
import {
  assertAuthProfileMigrationCandidates,
  assertAuthProfileMigrationStateAtDatabasePath,
} from "./legacy-source-diagnostic.js";
import { getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath } from "./mutation-lineage.js";
import {
  captureRuntimeAuthProfileLegacyCandidates,
  createEmptyAuthProfileStore,
  listRuntimeLocalProfileIds,
  markRuntimePersistedProfiles,
  mergeLocalAuthProfileStoreWithInheritedStore,
  runtimeAuthProfileSnapshotSharesOwner,
  setRuntimeLocalProfileMetadata,
} from "./runtime-snapshot-owner.js";
import { publishPreparedRuntimeAuthProfileStoreSnapshot } from "./runtime-snapshot-publication.js";
import {
  clearRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  listRuntimeAuthProfileStoreSnapshotsForSharedOwner,
  noteRuntimeAuthProfileStorePersistedMutation,
} from "./runtime-snapshots.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readSharedAuthProfileRows,
} from "./sqlite-read.js";
import { resolveAuthProfileDatabaseOwnerId, type PreparedAuthProfileStoreOwner } from "./sqlite.js";
import type { AuthProfileRowRead, AuthProfileStore } from "./types.js";

/** Reconcile committed facts through the existing snapshot owner, without native host rereads. */
export async function publishInlineAuthFailure(
  owner: PreparedAuthProfileStoreOwner,
  receipt: InlineAuthFailureReceipt,
  readTarget: () => Promise<AuthProfileRowRead>,
  assertOwner: () => void,
): Promise<void> {
  const agentDir = path.dirname(owner.databasePath);
  const shared = owner.databasePath === owner.sharedDatabasePath;
  const current = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath);
  // Capture affected owners before mutation notification; overlays are selected again at publication.
  const entries = [
    ...(current ? [current] : []),
    ...(shared ? listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner) : []),
  ];
  noteRuntimeAuthProfileStorePersistedMutation(agentDir, receipt.publication, owner);
  if (entries.length === 0) {
    return;
  }
  const readers = new Set<ReturnType<typeof prepareAgentAuthProfileRowsRead>>();
  const read = async (databasePath: string, kind: "agent" | "shared-state") => {
    const revision = getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(databasePath);
    let assertCurrent: () => void;
    let rows: AuthProfileRowRead;
    if (databasePath === owner.databasePath) {
      rows = await readTarget();
      assertCurrent = assertOwner;
    } else if (kind === "shared-state") {
      const context = captureOpenClawStateWorkerContext({ env: owner.env });
      if (context.admission.databasePath !== databasePath) {
        throw new Error("Auth snapshot changed its captured shared database");
      }
      rows = await readSharedAuthProfileRows(context);
      assertCurrent = () => context.admission.assertCurrent();
    } else {
      const reader = prepareAgentAuthProfileRowsRead({
        databasePath,
        agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
        env: owner.env,
      });
      readers.add(reader);
      rows = await reader.read();
      assertCurrent = reader.assertCurrent;
    }
    const assert = () => {
      assertOwner();
      assertCurrent();
      if (getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(databasePath) !== revision) {
        throw new Error("Auth snapshot changed during committed-state preparation");
      }
    };
    assert();
    return {
      store: markRuntimePersistedProfiles(
        loadPersistedAuthProfileStoreFromRows(rows, databasePath) ?? createEmptyAuthProfileStore(),
      ),
      assertCurrent: assert,
    };
  };
  for (const entry of entries) {
    const targetOwner = { ...owner, databasePath: entry.databasePath };
    try {
      assertOwner();
      assertAuthProfileMigrationStateAtDatabasePath(targetOwner.databasePath);
      assertAuthProfileMigrationStateAtDatabasePath(targetOwner.sharedDatabasePath);
      const candidates = captureRuntimeAuthProfileLegacyCandidates(
        targetOwner.databasePath === targetOwner.sharedDatabasePath ? undefined : entry.agentDir,
        owner.env,
      );
      const inherited =
        targetOwner.databasePath === targetOwner.sharedDatabasePath
          ? undefined
          : await read(
              targetOwner.sharedDatabasePath,
              owner.location === "state-db" ? "shared-state" : "agent",
            );
      const local = await read(targetOwner.databasePath, "agent");
      inherited?.assertCurrent();
      local.assertCurrent();
      assertAuthProfileMigrationCandidates({
        databasePath: targetOwner.databasePath,
        candidates:
          targetOwner.databasePath === targetOwner.sharedDatabasePath
            ? candidates.shared
            : candidates.local,
        hasCredentials: () => Object.keys(local.store.profiles).length > 0,
      });
      if (inherited) {
        assertAuthProfileMigrationCandidates({
          databasePath: targetOwner.sharedDatabasePath,
          candidates: candidates.shared,
          hasCredentials: () => Object.keys(inherited.store.profiles).length > 0,
        });
      }
      const refreshed: AuthProfileStore = inherited
        ? mergeLocalAuthProfileStoreWithInheritedStore(local.store, inherited.store)
        : setRuntimeLocalProfileMetadata(local.store, listRuntimeLocalProfileIds(local.store));
      const latest = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(entry.databasePath);
      if (!latest || !runtimeAuthProfileSnapshotSharesOwner(latest.owner, targetOwner)) {
        continue;
      }
      publishPreparedRuntimeAuthProfileStoreSnapshot(
        entry.agentDir,
        latest,
        targetOwner,
        refreshed,
        { candidates },
      );
    } catch (error) {
      try {
        const latest = getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(entry.databasePath);
        if (latest && runtimeAuthProfileSnapshotSharesOwner(latest.owner, targetOwner)) {
          clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(entry.databasePath, entry.agentDir);
        }
      } catch (invalidationError) {
        reportCommittedInlineAuthFailure(
          "auth usage snapshot invalidation failed",
          invalidationError,
        );
      }
      reportCommittedInlineAuthFailure(
        "auth usage committed but runtime snapshot publication failed",
        error,
      );
    } finally {
      const cleanup = await Promise.allSettled([...readers].map((reader) => reader.dispose()));
      readers.clear();
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        reportCommittedInlineAuthFailure(
          "auth snapshot publication finished before reader cleanup failed",
          errors,
        );
      }
    }
  }
}
