import { isDeepStrictEqual } from "node:util";
import type { AuthProfileStore } from "../auth-profiles/types.js";

export function materializeAuthStorageStore(
  store: AuthProfileStore,
  snapshots: readonly AuthProfileStore[],
): AuthProfileStore {
  if (snapshots.length === 0) {
    return store;
  }
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).map(([profileId, credential]) => {
      const runtimeCredential = snapshots
        .map((snapshot) => snapshot.profiles[profileId])
        .find((candidate) =>
          credential.type === "api_key" && credential.keyRef
            ? candidate?.type === "api_key" &&
              Boolean(candidate.key) &&
              candidate.provider === credential.provider &&
              isDeepStrictEqual(candidate.keyRef, credential.keyRef)
            : credential.type === "token" && credential.tokenRef
              ? candidate?.type === "token" &&
                Boolean(candidate.token) &&
                candidate.provider === credential.provider &&
                isDeepStrictEqual(candidate.tokenRef, credential.tokenRef)
              : false,
        );
      const needsMaterializedRef =
        (credential.type === "api_key" && Boolean(credential.keyRef)) ||
        (credential.type === "token" && Boolean(credential.tokenRef));
      return [
        profileId,
        needsMaterializedRef && runtimeCredential ? runtimeCredential : credential,
      ];
    }),
  );
  return { ...store, profiles };
}
