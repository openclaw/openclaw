import { AUTH_STORE_VERSION } from "./constants.js";
import type { AuthProfileCredential, AuthProfileSecretsStore, AuthProfileStore } from "./types.js";

type AuthProfilePortabilityReason =
  | "portable-static-credential"
  | "non-portable-oauth-refresh-token"
  | "credential-opted-out"
  | "setup-inactive"
  | "oauth-provider-opted-in";

export type AuthProfilePortability = {
  portable: boolean;
  reason: AuthProfilePortabilityReason;
};

export function resolveAuthProfilePortability(
  credential: AuthProfileCredential,
): AuthProfilePortability {
  if (credential.setup?.replacement) {
    return { portable: false, reason: "setup-inactive" };
  }
  const override = credential.copyToAgents;
  if (override === false) {
    return { portable: false, reason: "credential-opted-out" };
  }
  if (credential.type === "oauth") {
    if (
      ![credential.access, credential.refresh].some(
        (value) => typeof value === "string" && value.trim().length > 0,
      )
    ) {
      return { portable: false, reason: "non-portable-oauth-refresh-token" };
    }
    return override === true
      ? { portable: true, reason: "oauth-provider-opted-in" }
      : { portable: false, reason: "non-portable-oauth-refresh-token" };
  }
  return { portable: true, reason: "portable-static-credential" };
}

/** Builds an agent-copy store containing only portable credentials and their order. */
export function buildPortableAuthProfileStoreForAgentCopy(store: AuthProfileStore): {
  store: AuthProfileStore;
  copiedProfileIds: string[];
  skippedProfileIds: string[];
} {
  const copiedProfileIds: string[] = [];
  const skippedProfileIds: string[] = [];
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).flatMap(([profileId, credential]) => {
      if (!resolveAuthProfilePortability(credential).portable) {
        skippedProfileIds.push(profileId);
        return [];
      }
      copiedProfileIds.push(profileId);
      return [[profileId, credential]];
    }),
  ) as AuthProfileSecretsStore["profiles"];

  const copiedSet = new Set(copiedProfileIds);
  const order = Object.fromEntries(
    Object.entries(store.order ?? {})
      .map(([provider, ids]) => [provider, ids.filter((id) => copiedSet.has(id))] as const)
      .filter(([, ids]) => ids.length > 0),
  );

  return {
    store: {
      version: AUTH_STORE_VERSION,
      profiles,
      ...(Object.keys(order).length > 0 ? { order } : {}),
    },
    copiedProfileIds,
    skippedProfileIds,
  };
}
