import { readConfigMachineState } from "../../state/config-machine-state.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../../state/openclaw-state-db-readonly.js";
import { readUserModelAuthProfile } from "../../state/user-model-accounts.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import { readAuthProfileRows, SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import { isMissingDatabasePath } from "./sqlite-read-pool.js";
import type { AuthProfileRowRead } from "./types.js";

export const authProfileOperations = {
  "authProfiles.read": (input: { artifactPreserving: boolean }, { stateOptions }) => {
    const read = (): AuthProfileRowRead => {
      const options = stateOptions();
      const missing: AuthProfileRowRead = {
        store: { status: "missing", reason: "database" },
        state: { status: "missing", reason: "database" },
        cacheable: false,
      };
      try {
        return (
          withExistingOpenClawStateDatabaseReadOnly(
            ({ db }) => readAuthProfileRows(db, options.path, "shared-state"),
            options,
          ) ?? missing
        );
      } catch {
        return isMissingDatabasePath(options.path)
          ? missing
          : {
              store: { status: "unreadable" },
              state: { status: "unreadable" },
              cacheable: false,
            };
      }
    };
    return input.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
  },
  "authProfiles.sharedOwnership": (input: { artifactPreserving: boolean }, { stateOptions }) => {
    const read = () => readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, stateOptions());
    return input.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
  },
  "authProfiles.personal": (
    input: { profileId: string; artifactPreserving: boolean },
    { stateOptions },
  ) => {
    const read = () => readUserModelAuthProfile(input.profileId, stateOptions());
    return input.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
  },
} satisfies WorkerOperationHandlers;
