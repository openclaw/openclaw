import { isDeepStrictEqual } from "node:util";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { AuthStoragePersistenceError } from "./auth-storage-error.js";
import type { AuthStorageData } from "./auth-storage-types.js";

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

function projectAuthStorageData(store: AuthProfileStore | null): AuthStorageData {
  const projected: AuthStorageData = {};
  for (const [profileId, credential] of Object.entries(store?.profiles ?? {})) {
    if (profileId !== `${credential.provider}:default`) {
      continue;
    }
    if (credential.type === "api_key" && credential.key) {
      projected[credential.provider] = { type: "api_key", key: credential.key };
    } else if (credential.type === "token" && credential.token) {
      projected[credential.provider] = {
        type: "token",
        token: credential.token,
        ...(credential.expires !== undefined ? { expires: credential.expires } : {}),
      };
    } else if (credential.type === "oauth") {
      projected[credential.provider] = { ...credential };
    }
  }
  return projected;
}

export function assertAuthStorageSecretRefsMaterialized(store: AuthProfileStore): void {
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    if (profileId !== `${credential.provider}:default`) {
      continue;
    }
    if (
      (credential.type === "api_key" && credential.keyRef && !credential.key) ||
      (credential.type === "token" && credential.tokenRef && !credential.token)
    ) {
      throw new AuthStoragePersistenceError(
        "AuthStorage.forAgent requires the active secrets runtime to materialize SecretRef credentials.",
        undefined,
      );
    }
  }
}

export function projectAuthoritativeAuthStorageData(
  store: AuthProfileStore,
  snapshots: readonly AuthProfileStore[],
): AuthStorageData {
  const materialized = materializeAuthStorageStore(store, snapshots);
  assertAuthStorageSecretRefsMaterialized(materialized);
  return projectAuthStorageData(materialized);
}

export function applyAuthStorageData(
  store: AuthProfileStore,
  data: AuthStorageData,
  materializedBaseline: AuthStorageData,
): AuthProfileStore {
  const profiles = { ...store.profiles };
  const projectedProviders = new Set([
    ...Object.keys(materializedBaseline),
    ...Object.entries(store.profiles).flatMap(([profileId, credential]) =>
      profileId === `${credential.provider}:default` ? [credential.provider] : [],
    ),
  ]);
  for (const provider of projectedProviders) {
    if (!data[provider]) {
      delete profiles[`${provider}:default`];
    }
  }
  for (const [provider, credential] of Object.entries(data)) {
    const profileId = `${provider}:default`;
    const existing = profiles[profileId];
    if (
      credential.type === "api_key" &&
      existing?.type === "api_key" &&
      existing.keyRef &&
      materializedBaseline[provider]?.type === "api_key" &&
      materializedBaseline[provider].key === credential.key
    ) {
      profiles[profileId] = existing;
      continue;
    }
    if (
      credential.type === "token" &&
      existing?.type === "token" &&
      existing.tokenRef &&
      materializedBaseline[provider]?.type === "token" &&
      materializedBaseline[provider].token === credential.token
    ) {
      profiles[profileId] = existing;
      continue;
    }
    profiles[profileId] =
      credential.type === "api_key"
        ? { type: "api_key", provider, key: credential.key }
        : credential.type === "token"
          ? { type: "token", provider, token: credential.token, expires: credential.expires }
          : { ...credential, provider };
  }
  return { ...store, profiles };
}
