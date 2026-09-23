import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerRuntimeCommand } from "../../state/openclaw-state-worker-contract.js";
import { readUserModelAuthProfile } from "../../state/user-model-accounts.js";
import { readAuthProfileRows, SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import { isMissingDatabasePath } from "./sqlite-read-pool.js";
import type { AuthProfileRowRead } from "./types.js";

export function executeAuthProfileReadCommand(
  command: Extract<
    OpenClawStateWorkerRuntimeCommand,
    { type: "authProfiles.read" | "authProfiles.sharedOwnership" | "authProfiles.personal" }
  >,
  databasePath: string,
) {
  const read = () => {
    const options = {
      path: databasePath,
      env: getSqliteWorkerStateContext().environment,
    };
    if (command.type === "authProfiles.sharedOwnership") {
      return readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, options);
    }
    if (command.type === "authProfiles.personal") {
      return readUserModelAuthProfile(command.input.profileId, options);
    }
    const missing: AuthProfileRowRead = {
      store: { status: "missing", reason: "database" },
      state: { status: "missing", reason: "database" },
      cacheable: false,
    };
    try {
      return (
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => readAuthProfileRows(db, databasePath, "shared-state"),
          options,
        ) ?? missing
      );
    } catch {
      return isMissingDatabasePath(databasePath)
        ? missing
        : {
            store: { status: "unreadable" as const },
            state: { status: "unreadable" as const },
            cacheable: false,
          };
    }
  };
  return command.input.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
}
