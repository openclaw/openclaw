import type { ProviderExternalAuthProfile } from "../../plugins/provider-external-auth.types.js";
import { resolveExternalAuthProfilesWithPlugins } from "../../plugins/provider-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

type NormalizedExternalAuthProfile = ProviderExternalAuthProfile & {
  persistence: "runtime-only" | "persisted";
  selectionPriority: "default" | "highest";
};

type ExternalAuthProfileMap = Map<string, NormalizedExternalAuthProfile>;
type ResolveExternalAuthProfiles = typeof resolveExternalAuthProfilesWithPlugins;

let resolveExternalAuthProfilesForRuntime: ResolveExternalAuthProfiles | undefined;

export const __testing = {
  resetResolveExternalAuthProfilesForTest(): void {
    resolveExternalAuthProfilesForRuntime = undefined;
  },
  setResolveExternalAuthProfilesForTest(resolver: ResolveExternalAuthProfiles): void {
    resolveExternalAuthProfilesForRuntime = resolver;
  },
};

function normalizeExternalAuthProfile(
  profile: ProviderExternalAuthProfile,
): NormalizedExternalAuthProfile | null {
  if (!profile?.profileId || !profile.credential) {
    return null;
  }
  return {
    ...profile,
    persistence: profile.persistence ?? "runtime-only",
    selectionPriority: profile.selectionPriority ?? "default",
  };
}

function resolveExternalAuthProfileMap(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): ExternalAuthProfileMap {
  const env = params.env ?? process.env;
  const resolveProfiles =
    resolveExternalAuthProfilesForRuntime ?? resolveExternalAuthProfilesWithPlugins;
  const profiles = resolveProfiles({
    env,
    context: {
      config: undefined,
      agentDir: params.agentDir,
      workspaceDir: undefined,
      env,
      store: params.store,
    },
  });

  const resolved: ExternalAuthProfileMap = new Map();
  for (const rawProfile of profiles) {
    const profile = normalizeExternalAuthProfile(rawProfile);
    if (!profile) {
      continue;
    }
    resolved.set(profile.profileId, profile);
  }
  return resolved;
}

function authCredentialMatches(a: AuthProfileCredential, b: AuthProfileCredential): boolean {
  if (a.type !== b.type || a.provider !== b.provider) {
    return false;
  }

  if (a.type === "oauth" && b.type === "oauth") {
    return (
      a.access === b.access &&
      a.refresh === b.refresh &&
      a.expires === b.expires &&
      a.clientId === b.clientId &&
      a.email === b.email &&
      a.displayName === b.displayName &&
      a.enterpriseUrl === b.enterpriseUrl &&
      a.projectId === b.projectId &&
      a.accountId === b.accountId &&
      a.managedBy === b.managedBy
    );
  }

  if (a.type === "api_key" && b.type === "api_key") {
    return (
      a.key === b.key &&
      a.email === b.email &&
      a.displayName === b.displayName &&
      JSON.stringify(a.keyRef ?? null) === JSON.stringify(b.keyRef ?? null) &&
      JSON.stringify(a.metadata ?? null) === JSON.stringify(b.metadata ?? null)
    );
  }

  if (a.type === "token" && b.type === "token") {
    return (
      a.token === b.token &&
      a.expires === b.expires &&
      a.email === b.email &&
      a.displayName === b.displayName &&
      JSON.stringify(a.tokenRef ?? null) === JSON.stringify(b.tokenRef ?? null)
    );
  }

  return false;
}

export function overlayExternalAuthProfiles(
  store: AuthProfileStore,
  params?: { agentDir?: string; env?: NodeJS.ProcessEnv },
): AuthProfileStore {
  const profiles = resolveExternalAuthProfileMap({
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

export function listRuntimeOnlyExternalAuthProfileIds(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  return listRuntimeOnlyExternalAuthProfiles(params).map((profile) => profile.profileId);
}

export function listRuntimeOnlyExternalAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): Array<{ profileId: string; selectionPriority: "default" | "highest" }> {
  return Array.from(
    resolveExternalAuthProfileMap({
      store: params.store,
      agentDir: params.agentDir,
      env: params.env,
    }).entries(),
  )
    .filter(([, profile]) => profile.persistence !== "persisted")
    .map(([profileId, profile]) => ({
      profileId,
      selectionPriority: profile.selectionPriority,
    }));
}

export function shouldPersistExternalAuthProfile(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const external = resolveExternalAuthProfileMap({
    store: params.store,
    agentDir: params.agentDir,
    env: params.env,
  }).get(params.profileId);
  if (!external || external.persistence === "persisted") {
    return true;
  }
  return !authCredentialMatches(external.credential, params.credential);
}

// Compat aliases while file/function naming catches up.
export const overlayExternalOAuthProfiles = overlayExternalAuthProfiles;
export const shouldPersistExternalOAuthProfile = shouldPersistExternalAuthProfile;
