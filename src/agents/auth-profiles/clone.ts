/**
 * Auth profile store cloning helpers.
 * Keeps store snapshots JSON-serializable before callers mutate or persist
 * profile state.
 */
import {
  copyAuthProfileAuthorizationIntent,
  copyAuthProfileAuthorizationInheritance,
} from "./authorization-lifetime.js";
import { cloneAuthProfileJsonValue } from "./clone-value.js";
import { copyCanonicalAuthProfileCredentialObservations } from "./credential-observation.js";
import type { AuthProfileStore } from "./types.js";

/** Deep-clones an auth profile store and rejects non-JSON values. */
export function cloneAuthProfileStore<T extends AuthProfileStore>(store: T): T {
  const cloned = cloneAuthProfileJsonValue(store);
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    const target = cloned.profiles[profileId];
    if (target) {
      copyAuthProfileAuthorizationIntent(credential, target);
    }
  }
  copyAuthProfileAuthorizationInheritance(store.profiles, cloned.profiles);
  copyCanonicalAuthProfileCredentialObservations(store.profiles, cloned.profiles);
  return cloned;
}
