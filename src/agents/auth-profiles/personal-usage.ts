import { isDeepStrictEqual } from "node:util";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { assertPersonalAuthProfileRuntime } from "./runtime-scope.js";
import { readUserModelAuthProfileAsync } from "./sqlite-read.js";
import type { AuthProfileStore } from "./types.js";
import type { PersonalAuthProfileUsageReduction } from "./usage-reduction.js";

/** Bind the physical owner before probing or yielding to its writer queue. */
export function preparePersonalAuthProfileUsage(store: AuthProfileStore, profileId: string) {
  assertPersonalAuthProfileRuntime();
  const context = captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
    assertPersonalAuthProfileRuntime();
  };
  return {
    read: () => readUserModelAuthProfileAsync(profileId, context),
    record(reduction: PersonalAuthProfileUsageReduction) {
      const captured = structuredClone(reduction);
      return runOpenClawStateWorkerOperation(
        context,
        async (scope) => {
          const result = await scope.execute({
            type: "authProfiles.personalUsage",
            input: { profileId, reduction: captured },
          });
          if (result && isDeepStrictEqual(store.profiles[profileId], captured.expectedProfile)) {
            store.usageStats = { ...store.usageStats, [profileId]: result.next };
          }
          return result;
        },
        {
          assertCurrent,
          createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
            context.admission.databasePath,
          ]),
        },
      ).catch((error: unknown) => {
        if (isSqliteLockError(error)) {
          return null;
        }
        throw error;
      });
    },
  };
}
