import { loadAuthProfileStoreWithoutExternalProfiles } from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";

/** Refresh claims settle against their selected owner, not its inherited runtime view. */
export function loadStoredOAuthRefreshStore(
  agentDir?: string,
  profileId?: string,
): AuthProfileStore {
  return loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
    allowKeychainPrompt: true,
    inheritedAuthDir: agentDir,
    profileId,
  });
}
