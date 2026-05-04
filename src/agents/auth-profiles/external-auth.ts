import { appendAgentExecDebug } from "../../cli/agent-exec-debug.js";
import type { ProviderExternalAuthProfile } from "../../plugins/provider-external-auth.types.js";
import { resolveExternalAuthProfilesWithPlugins } from "../../plugins/provider-runtime.js";
import * as externalCliSync from "./external-cli-sync.js";
import {
  overlayRuntimeExternalOAuthProfiles,
  shouldPersistRuntimeExternalOAuthProfile,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

type ExternalAuthProfileMap = Map<string, ProviderExternalAuthProfile>;
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
): ProviderExternalAuthProfile | null {
  if (!profile?.profileId || !profile.credential) {
    return null;
  }
  return {
    ...profile,
    persistence: profile.persistence ?? "runtime-only",
  };
}

type ExternalAuthRuntimeContextParams = {
  commandName?: string;
  effectiveToolPolicy?: string;
};

function resolveExternalAuthProfileMap(
  params: {
    store: AuthProfileStore;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
  } & ExternalAuthRuntimeContextParams,
): ExternalAuthProfileMap {
  const env = params.env ?? process.env;
  const usesRuntimeOverride = resolveExternalAuthProfilesForRuntime != null;
  const resolveProfiles =
    resolveExternalAuthProfilesForRuntime ?? resolveExternalAuthProfilesWithPlugins;
  appendAgentExecDebug("external-auth", "externalAuth_resolveProfiles_call", {
    raw_commandName: params.commandName ?? null,
    raw_effectiveToolPolicy: params.effectiveToolPolicy ?? null,
    has_commandName: params.commandName !== undefined,
    has_effectiveToolPolicy: params.effectiveToolPolicy !== undefined,
    uses_runtime_override: usesRuntimeOverride,
    selected_resolver: usesRuntimeOverride ? "runtime_override" : "with_plugins",
  });
  const profiles = resolveProfiles({
    env,
    commandName: params.commandName,
    effectiveToolPolicy: params.effectiveToolPolicy,
    context: {
      config: undefined,
      agentDir: params.agentDir,
      workspaceDir: undefined,
      env,
      store: params.store,
    },
  });

  const resolved: ExternalAuthProfileMap = new Map();
  const cliProfiles = externalCliSync.resolveExternalCliAuthProfiles?.(params.store) ?? [];
  for (const profile of cliProfiles) {
    resolved.set(profile.profileId, {
      profileId: profile.profileId,
      credential: profile.credential,
      persistence: "runtime-only",
    });
  }
  for (const rawProfile of profiles) {
    const profile = normalizeExternalAuthProfile(rawProfile);
    if (!profile) {
      continue;
    }
    resolved.set(profile.profileId, profile);
  }
  return resolved;
}

function listRuntimeExternalAuthProfiles(
  params: {
    store: AuthProfileStore;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
  } & ExternalAuthRuntimeContextParams,
): RuntimeExternalOAuthProfile[] {
  return Array.from(
    resolveExternalAuthProfileMap({
      store: params.store,
      agentDir: params.agentDir,
      env: params.env,
      commandName: params.commandName,
      effectiveToolPolicy: params.effectiveToolPolicy,
    }).values(),
  );
}

export function overlayExternalAuthProfiles(
  store: AuthProfileStore,
  params?: { agentDir?: string; env?: NodeJS.ProcessEnv } & ExternalAuthRuntimeContextParams,
): AuthProfileStore {
  const profiles = listRuntimeExternalAuthProfiles({
    store,
    agentDir: params?.agentDir,
    env: params?.env,
    commandName: params?.commandName,
    effectiveToolPolicy: params?.effectiveToolPolicy,
  });
  return overlayRuntimeExternalOAuthProfiles(store, profiles);
}

export function shouldPersistExternalAuthProfile(
  params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
  } & ExternalAuthRuntimeContextParams,
): boolean {
  const profiles = listRuntimeExternalAuthProfiles({
    store: params.store,
    agentDir: params.agentDir,
    env: params.env,
    commandName: params.commandName,
    effectiveToolPolicy: params.effectiveToolPolicy,
  });
  return shouldPersistRuntimeExternalOAuthProfile({
    profileId: params.profileId,
    credential: params.credential,
    profiles,
  });
}

// Compat aliases while file/function naming catches up.
export const overlayExternalOAuthProfiles = overlayExternalAuthProfiles;
export const shouldPersistExternalOAuthProfile = shouldPersistExternalAuthProfile;
