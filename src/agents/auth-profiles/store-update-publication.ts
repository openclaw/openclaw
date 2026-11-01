import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../../infra/sqlite-worker-operation-admission.js";
import { observeSqliteWorkerAdmissionFinish } from "../../infra/sqlite-worker-operation-settlement.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { authProfileCredentialPublication } from "../../state/user-model-account-authority.js";
import { fenceAuthProfileAuthorizationWrite } from "./authorization-observation.js";
import { reportCommittedInlineAuthFailure } from "./constants.js";
import { observeCanonicalAuthProfileCredentials } from "./credential-observation.js";
import { publishInlineAuthFailure } from "./inline-usage-publication.js";
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
  getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath,
  listRuntimeAuthProfileStoreSnapshotsForSharedOwner,
  noteRuntimeAuthProfileStorePersistedMutation,
  publishRuntimeAuthProfileSharedCredentialMutation,
} from "./runtime-snapshots.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readSharedAuthProfileRows,
} from "./sqlite-read.js";
import { resolveAuthProfileDatabaseOwnerId } from "./sqlite.js";
import type { watchAuthProfileNativeCommits } from "./store-update-commit.js";
import type { AuthStoreUpdateCommitted } from "./store-update.worker.js";
import type { PreparedAuthProfileStoreOwner } from "./types.js";

/** Native receipt settlement owns credential publication, independently of result delivery. */
export function createAuthProfileStoreUpdatePublication(params: {
  databasePath: string;
  collectCommitted: () => AuthStoreUpdateCommitted | undefined;
  committedIsCurrent: () => boolean;
  assertCurrent: () => void;
}): (
  createAdmission: (collect: () => void) => SqliteWorkerAdmissionFactory,
) => SqliteWorkerAdmissionFactory {
  let settleAuthorization: ReturnType<typeof fenceAuthProfileAuthorizationWrite> | undefined;
  let authorizationPostimage: unknown;
  return (createAdmission) => (operation) => {
    let publication: ReturnType<typeof authProfileCredentialPublication.begin> | undefined;
    let authorizationCommitted = false;
    const retained = createAdmission(() => {
      const committed = params.collectCommitted();
      if (committed?.publication.credentialsChanged) {
        authorizationPostimage = {
          profiles: committed.store.profiles,
          authorizationLifetimes: committed.authorizationLifetimes,
        };
        settleAuthorization = fenceAuthProfileAuthorizationWrite(params.databasePath);
      }
      const credentialOwner = committed?.credentialOwner;
      if (credentialOwner) {
        publication = authProfileCredentialPublication.begin({
          ...credentialOwner,
          assertCurrent: params.assertCurrent,
        });
      }
    })(operation);
    const { admission } = retained;
    observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
      const credentials = isRecord(facts) ? facts.authCredentials : undefined;
      publication?.committed(credentials);
      authorizationCommitted =
        publication !== undefined && !(isRecord(credentials) && credentials.kind === "unknown");
    });
    const finishAuthorization = (known: boolean) => {
      // Native settlement, not delivery of the operation result, owns this projection.
      const receipt = admission.committed;
      settleAuthorization?.(
        known && (!receipt || authorizationCommitted),
        authorizationCommitted && params.committedIsCurrent() ? authorizationPostimage : undefined,
      );
    };
    observeSqliteWorkerAdmissionFinish(admission, () => {
      if (admission.settlement) {
        const confirmed = admission.settlement.kind === "completed";
        publication?.finish(confirmed, confirmed && !admission.committed);
        finishAuthorization(confirmed);
      }
    });
    void operation.settled.then((outcome) => {
      const known = outcome.kind !== "unknown";
      publication?.finish(known, known && !admission.committed);
      finishAuthorization(known);
    });
    return retained;
  };
}

/** Publish affected owners from committed facts, rereading only an overtaken result. */
export async function publishAuthProfileStoreUpdate(
  owner: PreparedAuthProfileStoreOwner,
  committed: AuthStoreUpdateCommitted,
  assertCurrent: () => void,
  nativeCommits: ReturnType<typeof watchAuthProfileNativeCommits>,
  committedIsCurrent: () => boolean,
): Promise<void> {
  assertCurrent();
  const shared = owner.databasePath === owner.sharedDatabasePath;
  let currentStore = committed.store;
  let mutation = committed.publication;
  let isCommittedCurrent = committedIsCurrent;
  const prepareReader = (databasePath: string, agentDir = path.dirname(databasePath)) =>
    prepareAgentAuthProfileRowsRead({
      databasePath,
      agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
      env: owner.env,
    });
  // A later native save may publish only its own delta. Keep this commit's
  // affected profiles, but reconcile them from rows that include both commits.
  while (!isCommittedCurrent()) {
    const current = nativeCommits.capture();
    const revision = getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(owner.databasePath);
    let rows;
    if (shared && owner.location === "state-db") {
      const context = captureOpenClawStateWorkerContext({ env: owner.env });
      rows = await readSharedAuthProfileRows(context);
      context.admission.assertCurrent();
    } else {
      const reader = prepareReader(owner.databasePath);
      try {
        rows = await reader.read();
      } finally {
        await reader.dispose();
      }
    }
    assertCurrent();
    currentStore =
      loadPersistedAuthProfileStoreFromRows(rows, owner.databasePath) ??
      createEmptyAuthProfileStore();
    mutation = committed.publication;
    isCommittedCurrent =
      getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(owner.databasePath) === revision
        ? current
        : () => false;
  }
  if (!shared) {
    // The shared owner can rotate while the local worker commits. Its current
    // rows and revision come from the same reader used by auth health publication.
    const reader = prepareReader(owner.databasePath);
    try {
      return await publishInlineAuthFailure(
        owner,
        { publication: mutation },
        reader.read,
        assertCurrent,
        {
          store: currentStore,
          isCurrent: isCommittedCurrent,
          nativeCommits,
        },
      );
    } finally {
      await reader.dispose();
    }
  }
  const installed = publishRuntimeAuthProfileSharedCredentialMutation(
    owner,
    currentStore,
    mutation,
  );
  const current = installed
    ? undefined
    : getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath);
  const entries = installed?.entries ?? [
    ...(current ? [current] : []),
    ...listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner, mutation),
  ];
  // A credential-only publication must not advance a derived snapshot while
  // retaining state that this committed update has not reconciled yet.
  if (mutation.stateChanged && !mutation.availabilityOnly) {
    for (const entry of entries) {
      if (entry.databasePath !== owner.databasePath) {
        clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(entry.databasePath, entry.agentDir);
      }
    }
  }
  let recordedRevision = installed?.revision;
  if (!installed) {
    observeCanonicalAuthProfileCredentials(owner.databasePath, currentStore.profiles);
    recordedRevision = noteRuntimeAuthProfileStorePersistedMutation(
      undefined,
      mutation,
      owner,
      undefined,
      { store: currentStore, env: owner.env },
    );
  }
  const sharedRevision = recordedRevision;
  const revisions =
    installed?.snapshots ??
    new Map(
      entries.map((entry) => [
        entry.databasePath,
        getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(entry.databasePath),
      ]),
    );
  for (const entry of entries) {
    const targetOwner = { ...owner, databasePath: entry.databasePath };
    let reader: ReturnType<typeof prepareAgentAuthProfileRowsRead> | undefined;
    const localRevision =
      installed?.mutations.get(entry.databasePath) ??
      getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(entry.databasePath);
    const stillCurrent = () =>
      isCommittedCurrent() &&
      getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(owner.sharedDatabasePath) ===
        sharedRevision &&
      getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(entry.databasePath) ===
        localRevision &&
      getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(entry.databasePath) ===
        revisions.get(entry.databasePath);
    try {
      assertCurrent();
      assertAuthProfileMigrationStateAtDatabasePath(targetOwner.databasePath);
      assertAuthProfileMigrationStateAtDatabasePath(targetOwner.sharedDatabasePath);
      let local = currentStore;
      if (entry.databasePath !== owner.databasePath) {
        reader = prepareReader(entry.databasePath, entry.agentDir);
        local = markRuntimePersistedProfiles(
          loadPersistedAuthProfileStoreFromRows(await reader.read(), entry.databasePath) ??
            createEmptyAuthProfileStore(),
        );
        assertCurrent();
        reader.assertCurrent();
      }
      if (!stillCurrent()) {
        continue;
      }
      const inherited = entry.databasePath === owner.sharedDatabasePath ? undefined : currentStore;
      const candidates = captureRuntimeAuthProfileLegacyCandidates(
        entry.databasePath === owner.sharedDatabasePath ? undefined : entry.agentDir,
        owner.env,
      );
      assertAuthProfileMigrationCandidates({
        databasePath: entry.databasePath,
        candidates:
          entry.databasePath === owner.sharedDatabasePath ? candidates.shared : candidates.local,
        hasCredentials: () => Object.keys(local.profiles).length > 0,
      });
      const refreshed = inherited
        ? mergeLocalAuthProfileStoreWithInheritedStore(local, inherited)
        : setRuntimeLocalProfileMetadata(local, listRuntimeLocalProfileIds(local));
      const latest =
        getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(entry.databasePath) ?? entry;
      if (!runtimeAuthProfileSnapshotSharesOwner(latest.owner, targetOwner)) {
        continue;
      }
      publishPreparedRuntimeAuthProfileStoreSnapshot(
        entry.agentDir,
        latest,
        targetOwner,
        refreshed,
        { candidates },
      );
    } finally {
      if (reader) {
        try {
          await reader.dispose();
        } catch (error) {
          reportCommittedInlineAuthFailure(
            "Auth snapshot reader cleanup failed after commit",
            error,
          );
        }
      }
    }
  }
}
