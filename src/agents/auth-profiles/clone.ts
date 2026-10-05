/**
 * Auth profile store cloning helpers.
 * Keeps store snapshots JSON-serializable before callers mutate or persist
 * profile state.
 */
import {
  copyAuthProfileAuthorizationIntent,
  copyAuthProfileAuthorizationInheritance,
} from "./authorization-lifetime.js";
import { copyCanonicalAuthProfileCredentialObservations } from "./credential-observation.js";
import type { AuthProfileStore } from "./types.js";

/** Deep-clones an auth profile store and rejects non-JSON values. */
export function cloneAuthProfileStore<T extends AuthProfileStore>(store: T): T {
  const cloned = JSON.parse(
    JSON.stringify(store, (_key, value: unknown) => {
      if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
        throw new TypeError(`AuthProfileStore contains non-JSON value: ${typeof value}`);
      }
      return value;
    }),
  ) as T;
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
