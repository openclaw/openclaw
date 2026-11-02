import { readUserModelAuthProfile } from "../../state/user-model-accounts.js";
import type { AuthProfileStore, UserModelAuthProfile } from "./types.js";

/** Personal credentials enter only the selected turn's view, never the shared profile pool. */
export function materializePersonalAuthProfile(
  store: AuthProfileStore,
  profileId: string,
): AuthProfileStore {
  return materializePreparedPersonalAuthProfile(
    store,
    profileId,
    readUserModelAuthProfile(profileId),
  );
}

/** Merge an explicitly selected account already read through its canonical owner. */
export function materializePreparedPersonalAuthProfile(
  store: AuthProfileStore,
  profileId: string,
  profile: UserModelAuthProfile | undefined,
): AuthProfileStore {
  if (!profile) {
    return store;
  }
  return {
    ...store,
    profiles: { ...store.profiles, [profileId]: profile.credential },
    runtimePersistedProfileIds: [
      ...new Set([...(store.runtimePersistedProfileIds ?? []), profileId]),
    ].toSorted(),
    ...(profile.usageStats
      ? { usageStats: { ...store.usageStats, [profileId]: profile.usageStats } }
      : {}),
  };
}
