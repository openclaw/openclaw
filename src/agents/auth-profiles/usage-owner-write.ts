/**
 * Owner-routed persistence for auth profile usage health.
 * Every usage mutation writes the profile's persisted owner store exactly once
 * and mirrors the committed entry into the caller's runtime view.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { updateAuthProfileStoreWithLock } from "./store-runtime.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "./store.js";
import type { AuthProfileStore } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";

const authProfileUsageLog = createSubsystemLogger("agent/embedded");

/** Test seam for the locked writer; usage.ts exposes it through its test API. */
export const authProfileUsageDeps = {
  updateAuthProfileStoreWithLock,
};

export function logDroppedAuthProfileBookkeeping(kind: string, profileId: string): void {
  authProfileUsageLog.warn("dropped auth profile bookkeeping after locked store update failed", {
    event: "auth_profile_bookkeeping_dropped",
    kind,
    profileId,
    tags: ["auth_profiles", "persistence"],
  });
}

export async function updateOwnedAuthProfileUsage(
  store: AuthProfileStore,
  profileId: string,
  update: Parameters<typeof updateAuthProfileStoreWithLock>[0],
) {
  // Inherited credentials exist only in the owner's SQLite store. A child lock
  // cannot persist their health state, so resolve the owner before the write.
  let changed = false;
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    ...update,
    profileId,
    agentDir: resolvePersistedAuthProfileOwnerAgentDir({
      agentDir: update.agentDir,
      profileId,
    }),
    updater: (freshStore) => {
      changed = update.updater(freshStore);
      return changed;
    },
  });
  const usage = changed ? updated?.usageStats?.[profileId] : undefined;
  if (usage) {
    store.usageStats = { ...store.usageStats, [profileId]: usage };
  }
  return updated;
}

/**
 * Clears persisted failure windows after the operator resolved the provider
 * condition early. Returns false only when the locked write was dropped.
 */
export async function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<boolean> {
  const { store, profileId, agentDir } = params;
  const updated = await updateOwnedAuthProfileUsage(store, profileId, {
    agentDir,
    updater: (freshStore) => {
      const stats = freshStore.usageStats?.[profileId];
      if (!stats) {
        return false;
      }
      freshStore.usageStats = {
        ...freshStore.usageStats,
        [profileId]: resetAuthProfileFailureState(stats),
      };
      return true;
    },
  });
  if (updated === null) {
    logDroppedAuthProfileBookkeeping("clear_cooldown", profileId);
    return false;
  }
  return true;
}
