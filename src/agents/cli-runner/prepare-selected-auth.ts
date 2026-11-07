import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasUsableOAuthCredential } from "../auth-profiles/credential-state.js";
import { resolveApiKeyForProfile } from "../auth-profiles/oauth.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { ResolvedProviderAuth } from "../model-auth-runtime-shared.js";
import { createCliProfileResolutionError } from "./auth-profile-preparation-error.js";

export async function prepareSelectedCliAuthProfile(params: {
  backendId: string;
  strict?: boolean;
  profileId: string;
  agentDir: string;
  provider: string;
  config?: OpenClawConfig;
  loadStore: (options: { profileId: string }) => Promise<AuthProfileStore>;
  assertCurrent?: () => void;
}) {
  const { agentDir, profileId, strict } = params;
  const profileResolutionError = createCliProfileResolutionError(
    params.backendId,
    profileId,
    agentDir,
  );
  const selectedStore = await params.loadStore({ profileId });
  const resolved = await resolveApiKeyForProfile({
    cfg: params.config,
    store: selectedStore,
    profileId,
    agentDir,
    // Claude's selected profile is an account boundary.
    ...(strict ? { allowProfileFallback: false } : {}),
  });
  params.assertCurrent?.();
  if (strict && resolved?.profileId !== profileId) {
    throw profileResolutionError(
      resolved?.provider ?? selectedStore.profiles[profileId]?.provider ?? params.provider,
      resolved?.profileId,
    );
  }
  const resolvedProfileId = resolved?.profileId ?? profileId;
  const authStore = await params.loadStore({ profileId: resolvedProfileId });
  let authCredential = resolved?.credential ?? authStore.profiles[resolvedProfileId];
  if (
    strict &&
    (!authCredential ||
      (authCredential.type === "oauth" && !hasUsableOAuthCredential(authCredential)))
  ) {
    throw profileResolutionError(resolved?.provider ?? params.provider);
  }

  const expectedCredential =
    resolved?.credential ??
    (resolved && selectedStore.profiles[resolvedProfileId]) ??
    authCredential;
  let resolvedProfileAuth: ResolvedProviderAuth | undefined;
  if (resolved && authCredential) {
    resolvedProfileAuth = {
      apiKey: resolved.apiKey,
      profileId: resolvedProfileId,
      source: `profile:${resolvedProfileId}`,
      mode: resolved.profileType === "api_key" ? "api-key" : resolved.profileType,
    };
    // The retained comparison uses the stored form before resolving SecretRefs.
    if (authCredential.type === "api_key") {
      authCredential = { ...authCredential, key: resolved.apiKey };
    } else if (authCredential.type === "token") {
      authCredential = { ...authCredential, token: resolved.apiKey };
    }
  }
  return {
    authStore,
    authCredential,
    expectedCredential,
    resolvedProfileAuth,
    profileId: resolvedProfileAuth ? resolvedProfileId : profileId,
    persistedProfileIds: selectedStore.runtimePersistedProfileIds,
  };
}
