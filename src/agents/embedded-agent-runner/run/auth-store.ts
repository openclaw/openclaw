import type { AuthProfileStore } from "../../auth-profiles.js";
import type { ResolvedProviderAuth } from "../../model-auth.js";
import type { RuntimeAuthState } from "./helpers.js";

export function resolveAttemptDispatchApiKey(params: {
  apiKeyInfo: ResolvedProviderAuth | null;
  runtimeAuthState: RuntimeAuthState | null;
  pluginHarnessOwnsTransport: boolean;
}): string | undefined {
  if (params.runtimeAuthState) {
    // Core streaming consumes the provider-prepared runtime credential from
    // authStorage. A transport-owning harness instead needs the original
    // resolved profile credential promised by its attempt contract.
    return params.pluginHarnessOwnsTransport ? params.runtimeAuthState.sourceApiKey : undefined;
  }
  return params.apiKeyInfo?.apiKey;
}

export function createScopedAuthProfileStore(
  store: AuthProfileStore,
  profileIds: readonly string[],
): AuthProfileStore {
  const profiles = store.profiles ?? {};
  const normalizedProfileIds = profileIds.map((profileId) => profileId.trim()).filter(Boolean);
  const scopedProfiles = Object.fromEntries(
    normalizedProfileIds.flatMap((profileId) => {
      const credential = profiles[profileId];
      return credential ? [[profileId, credential] as const] : [];
    }),
  );
  const filterProfiles = (ids?: readonly string[]) =>
    (ids ?? []).filter((profileId) => scopedProfiles[profileId]);
  const scopedRuntimeExternalProfileIds = filterProfiles(store.runtimeExternalProfileIds);
  const scopedRuntimePersistedProfileIds = filterProfiles(store.runtimePersistedProfileIds);
  return Object.keys(scopedProfiles).length > 0
    ? {
        version: store.version,
        profiles: scopedProfiles,
        ...(scopedRuntimePersistedProfileIds.length > 0
          ? { runtimePersistedProfileIds: scopedRuntimePersistedProfileIds }
          : {}),
        ...(scopedRuntimeExternalProfileIds.length > 0 ||
        store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIds: scopedRuntimeExternalProfileIds }
          : {}),
        ...(store.runtimeExternalProfileIdsAuthoritative === true
          ? { runtimeExternalProfileIdsAuthoritative: true }
          : {}),
      }
    : { version: 1, profiles: {} };
}
