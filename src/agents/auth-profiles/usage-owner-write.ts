/**
 * Owner-routed persistence for auth profile usage health.
 * Every usage mutation writes the profile's persisted owner store exactly once
 * and mirrors the committed entry into the caller's runtime view.
 */
import { inspectPersistedAuthProfileStateRaw } from "./sqlite.js";
import { logDroppedAuthProfileBookkeeping } from "./state-observation.js";
import { coerceAuthProfileState } from "./state.js";
import {
  resolvePersistedAuthProfileOwnerAgentDirAsync,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";

export async function updateOwnedAuthProfileUsage(
  store: AuthProfileStore,
  profileId: string,
  update: Parameters<typeof updateAuthProfileStoreWithLock>[0],
) {
  // Inherited credentials exist only in the owner's SQLite store. A child lock
  // cannot persist their health state, so resolve the owner before the write.
  let changed = false;
  const updated = await updateAuthProfileStoreWithLock({
    ...update,
    profileId,
    agentDir: await resolvePersistedAuthProfileOwnerAgentDirAsync({
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
 * condition early. Returns false only when a locked write was dropped.
 */
export async function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<boolean> {
  const { store, profileId, agentDir } = params;
  const reset = (freshStore: AuthProfileStore) => {
    const stats = freshStore.usageStats?.[profileId];
    if (!stats) {
      return false;
    }
    const cleared = resetAuthProfileFailureState(stats);
    // Serialization drops the cleared (undefined) fields, so a clean row compares equal.
    if (JSON.stringify(stats) === JSON.stringify(cleared)) {
      return false;
    }
    freshStore.usageStats = { ...freshStore.usageStats, [profileId]: cleared };
    return true;
  };
  const ownerWrite = await updateOwnedAuthProfileUsage(store, profileId, {
    agentDir,
    updater: reset,
  });
  // A row in the agent's own database wins over the owner's after reload (inline-key
  // failures, local overrides), and owner routing never reaches it. Reset it in place,
  // but only when it exists: a locked write would create a database for an unused agent.
  const localState = agentDir ? inspectPersistedAuthProfileStateRaw(agentDir) : undefined;
  const hasLocalRow =
    localState?.status === "readable" &&
    coerceAuthProfileState(localState.raw).usageStats?.[profileId] !== undefined;
  let localChanged = false;
  const localWrite = hasLocalRow
    ? await updateAuthProfileStoreWithLock({
        agentDir,
        profileId,
        updater: (freshStore) => {
          localChanged = reset(freshStore);
          return localChanged;
        },
      })
    : ownerWrite;
  const localStats = localChanged ? localWrite?.usageStats?.[profileId] : undefined;
  if (localStats) {
    store.usageStats = { ...store.usageStats, [profileId]: localStats };
  }
  if (ownerWrite === null || localWrite === null) {
    logDroppedAuthProfileBookkeeping("clear_cooldown", profileId);
    return false;
  }
  return true;
}
