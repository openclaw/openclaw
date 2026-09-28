import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnershipAsync,
} from "./path-resolve.js";
import { resolveAuthProfilePortability } from "./portability.js";
import {
  createEmptyAuthProfileStore,
  pruneAuthProfileStoreReferences,
} from "./runtime-snapshot-owner.js";
import { loadPersistedAuthProfileStoreFromRows, readSharedAuthProfileRows } from "./sqlite-read.js";
import type { AuthProfileStore } from "./types.js";

/** Prepare the shared read-through view; the scope owner validates it immediately before entry. */
export async function prepareScopedSharedAuthProfileStore(env: NodeJS.ProcessEnv): Promise<{
  sharedStore: AuthProfileStore | undefined;
  assertCurrent: () => void;
}> {
  const context = captureOpenClawStateWorkerContext({ env });
  const ownership = await resolveSharedAuthStoreOwnershipAsync(context);
  let sharedStore: AuthProfileStore | undefined;
  if (ownership.location === "state-db") {
    sharedStore =
      loadPersistedAuthProfileStoreFromRows(
        await readSharedAuthProfileRows(context),
        context.admission.databasePath,
      ) ?? createEmptyAuthProfileStore();
    // Temporary runs must not acquire a second OAuth refresh owner. This view
    // stays inside the operation scope and is never persisted into an agent store.
    sharedStore.profiles = Object.fromEntries(
      Object.entries(sharedStore.profiles).filter(
        ([, credential]) =>
          resolveAuthProfilePortability(credential).reason === "portable-static-credential",
      ),
    );
    pruneAuthProfileStoreReferences(sharedStore, new Set(Object.keys(sharedStore.profiles)));
  }
  return {
    sharedStore,
    assertCurrent() {
      context.admission.assertCurrent();
      context.maintenanceScope?.assertAdmission();
      if (resolveSharedAuthStoreOwnership(env).location !== ownership.location) {
        throw new Error(
          "Shared auth store ownership changed during scope preparation; retry the operation.",
        );
      }
    },
  };
}
