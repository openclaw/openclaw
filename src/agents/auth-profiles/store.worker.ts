import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MessageChannel } from "node:worker_threads";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { getDatabaseEngineInput } from "../../infra/database-engine/context.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { openSqliteReadOnlyDatabase } from "../../infra/sqlite-snapshot-source.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { personalCredentialPublication } from "../../state/user-model-account-authority.js";
import {
  encodeUserModelAuthProfile,
  readUserModelAuthProfile,
  updateUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import {
  enrollAuthProfileAuthorizationInDatabase,
  type AuthProfileAuthorizationEnrollment,
} from "./authorization-enrollment.js";
import { bootstrapSharedAuthStoreInWorker } from "./shared-store-bootstrap.worker.js";
import { readAuthProfileRows, readAuthProfileRowsReadOnly } from "./sqlite-json.js";
import { closeAuthProfileReadDatabase, isMissingDatabasePath } from "./sqlite-read-pool.js";
import { sendAuthProfileUpdateValue } from "./store-update-transfer.js";
import { updateAuthProfileStoreInDatabase } from "./store-update.worker.js";
import type {
  AuthProfileReadSource,
  AuthProfileUsageInput,
  AuthProfileUsageResult,
  AuthStoreUpdateInput,
} from "./store.worker-contract.js";
import type { AuthProfileRowRead, ProfileUsageStats, UserModelAuthProfile } from "./types.js";
import { recordAuthProfileUsageInDatabase } from "./usage-kernel.js";
import type { PersonalAuthProfileUsageReduction } from "./usage-reduction.js";
import { reduceAuthProfileFailure } from "./usage-reduction.js";
import { resetAuthProfileFailureState } from "./usage-state.js";

function readAuthProfileSource(
  source: AuthProfileReadSource,
  options: { path: string; env: NodeJS.ProcessEnv },
): AuthProfileRowRead {
  const missing: AuthProfileRowRead = {
    store: { status: "missing", reason: "database" },
    state: { status: "missing", reason: "database" },
    cacheable: false,
  };
  const unreadable: AuthProfileRowRead = {
    store: { status: "unreadable" },
    state: { status: "unreadable" },
    cacheable: false,
  };
  if (source.kind === "agent") {
    if (!source.identity) {
      return unreadable;
    }
    if (!source.identity.startsWith("file:")) {
      return missing;
    }
    if (!getDatabaseEngineInput("agent")) {
      try {
        return readAuthProfileRowsReadOnly(
          source.databasePath,
          openSqliteReadOnlyDatabase,
          source.schema,
          source.identity,
        );
      } finally {
        // Agent deletion does not broadcast to the state actor's retained native handles.
        closeAuthProfileReadDatabase(source.databasePath);
      }
    }
  }
  try {
    if (source.kind === "agent") {
      const result = withFreshOpenClawAgentDatabaseReadOnly(
        ({ db }) => readAuthProfileRows(db, source.databasePath, "agent"),
        { agentId: source.agentId, path: source.databasePath, env: options.env },
        { snapshot: true },
      );
      return result.found ? result.value : missing;
    }
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
        const read = () => readAuthProfileRows(db, source.databasePath, "shared-state");
        return isPostgresSqlConnection(db) ? runSqliteReadSnapshotSync(db, read) : read();
      }, options) ?? missing
    );
  } catch {
    return isMissingDatabasePath(source.databasePath) ? missing : unreadable;
  }
}

export const authProfileOperations = {
  "authProfiles.enrollAuthorization": (
    input: AuthProfileAuthorizationEnrollment,
    { open, stateOptions },
  ) => {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const result = enrollAuthProfileAuthorizationInDatabase(db, "shared-state", input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      { ...stateOptions(), database },
    );
  },
  "authProfiles.bootstrap": bootstrapSharedAuthStoreInWorker,
  "authProfiles.personalReplace": (
    input: { profileId: string; expected: UserModelAuthProfile; next: UserModelAuthProfile },
    { open, stateOptions },
  ): UserModelAuthProfile | undefined => {
    const database = open();
    const options = { ...stateOptions(), database };
    let committed: UserModelAuthProfile | undefined;
    personalCredentialPublication.capture(database.db, () =>
      updateUserModelAuthProfile(
        input.profileId,
        (profile) => {
          if (!isDeepStrictEqual(profile, input.expected)) {
            return false;
          }
          profile.credential = input.next.credential;
          profile.usageStats = input.next.usageStats;
          return true;
        },
        options,
        (operation) => {
          if (operation.stage === "transaction") {
            requestSqliteWorkerOperationAdmission({ stage: operation.stage, facts: undefined });
          } else {
            committed = operation.profile;
            if (encodeUserModelAuthProfile(committed) !== encodeUserModelAuthProfile(input.next)) {
              throw new Error("Personal credential codec changed the prepared update");
            }
            const digest = createHash("sha256").update(stableStringify(committed)).digest("hex");
            requestSqliteWorkerOperationAdmission({ stage: operation.stage, facts: digest });
            deferSqliteWorkerCommitReceipt(database.db, {
              digest,
              personalCredentials: personalCredentialPublication.capture(database.db, () => {})
                .receipt,
            });
          }
        },
      ),
    );
    return committed;
  },
  "authProfiles.update": (input: AuthStoreUpdateInput, { stateOptions }) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        updateAuthProfileStoreInDatabase(db, "shared-state", input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return true;
      },
      stateOptions(),
      { operationLabel: "auth-profiles.update" },
    ),
  "authProfiles.usage": (input: AuthProfileUsageInput, { stateOptions }): AuthProfileUsageResult =>
    runOpenClawStateWriteTransaction(
      ({ db, path }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const receipt = recordAuthProfileUsageInDatabase(db, path, "shared-state", input);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return { ok: true, receipt };
      },
      stateOptions(),
      { operationLabel: "auth-profiles.usage" },
    ),
  "authProfiles.personalUsage": (
    input: { profileId: string; reduction: PersonalAuthProfileUsageReduction },
    { stateOptions },
  ): ProfileUsageStats | undefined => {
    let result: ProfileUsageStats | undefined;
    updateUserModelAuthProfile(
      input.profileId,
      (profile) => {
        if (!isDeepStrictEqual(profile.credential, input.reduction.expectedProfile)) {
          return false;
        }
        const now = Date.now();
        const previous = profile.usageStats;
        const next =
          input.reduction.kind === "success"
            ? resetAuthProfileFailureState(
                previous ?? {},
                {
                  lastUsed: input.reduction.lastUsed,
                  lastProbeAt: now,
                },
                input.reduction.modelId,
              )
            : reduceAuthProfileFailure(profile.credential, previous, input.reduction, now);
        if (!next) {
          return false;
        }
        profile.usageStats = next;
        result = next;
        return true;
      },
      stateOptions(),
      ({ stage }) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    );
    return result;
  },
  "authProfiles.readSources": (
    input: { artifactPreserving: boolean; sources: AuthProfileReadSource[] },
    { stateOptions },
  ) => {
    const options = stateOptions();
    const read = () =>
      Object.fromEntries(
        input.sources.map((source) => [
          source.databasePath,
          readAuthProfileSource(source, options),
        ]),
      );
    const rows = input.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
    const { port1, port2 } = new MessageChannel();
    try {
      sendAuthProfileUpdateValue(port1, rows);
      requestSqliteWorkerOperationAdmission(
        { stage: "prepare", facts: { kind: "auth-sources-read", port: port2 } },
        [port2],
      );
    } finally {
      port1.close();
      port2.close();
    }
  },
  "authProfiles.personal": (
    input: { profileId: string; artifactPreserving: boolean },
    { stateOptions },
  ) => {
    const read = () => readUserModelAuthProfile(input.profileId, stateOptions());
    return input.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
  },
} satisfies WorkerOperationHandlers;
