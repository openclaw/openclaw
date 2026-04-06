import { resolveExternalAuthProfilesWithPlugins } from "../../plugins/provider-runtime.js";
import type { ProviderExternalAuthProfile } from "../../plugins/types.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

type ExternalOAuthProfileMap = Map<string, ProviderExternalAuthProfile>;

function normalizeExternalOAuthProfile(
  profile: ProviderExternalAuthProfile,
): ProviderExternalAuthProfile | null {
  if (!profile?.profileId || !profile.credential) {
    return null;
  }
  return {
    ...profile,
    persistence: profile.persistence ?? "runtime-only",
  };
}

function resolveExternalOAuthProfileMap(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): ExternalOAuthProfileMap {
  const env = params.env ?? process.env;
  const profiles = resolveExternalAuthProfilesWithPlugins({
    env,
    context: {
      config: undefined,
      agentDir: params.agentDir,
      workspaceDir: undefined,
      env,
      store: params.store,
    },
  });

  const resolved: ExternalOAuthProfileMap = new Map();
  for (const rawProfile of profiles) {
    const profile = normalizeExternalOAuthProfile(rawProfile);
    if (!profile) {
      continue;
    }
    resolved.set(profile.profileId, profile);
  }
  return resolved;
}

function oauthCredentialMatches(a: OAuthCredential, b: OAuthCredential): boolean {
  return (
    a.type === b.type &&
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.clientId === b.clientId &&
    a.email === b.email &&
    a.displayName === b.displayName &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId
  );
}

export function overlayExternalOAuthProfiles(
  store: AuthProfileStore,
  params?: { agentDir?: string; env?: NodeJS.ProcessEnv },
): AuthProfileStore {
  const profiles = resolveExternalOAuthProfileMap({
    store,
    agentDir: params?.agentDir,
    env: params?.env,
  });
  if (profiles.size === 0) {
    return store;
  }

  const next = structuredClone(store);
  for (const [profileId, profile] of profiles) {
    next.profiles[profileId] = profile.credential;
  }
  return next;
}

export function shouldPersistExternalOAuthProfile(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const external = resolveExternalOAuthProfileMap({
    store: params.store,
    agentDir: params.agentDir,
    env: params.env,
  }).get(params.profileId);
  if (!external || external.persistence === "persisted") {
    return true;
  }
  return !oauthCredentialMatches(external.credential, params.credential);
}
