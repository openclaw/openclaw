import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { resolveAuthStorePath } from "./path-resolve.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

const CANONICAL_MAIN_OAUTH_PROVIDERS = new Set<string>(["openai-codex"]);

export function hasCanonicalMainOAuthOwner(provider: string): boolean {
  return CANONICAL_MAIN_OAUTH_PROVIDERS.has(resolveProviderIdForAuth(provider));
}

export function resolveCanonicalOAuthOwnerAgentDir(params: {
  provider: string;
  agentDir?: string;
}): string | undefined {
  if (!hasCanonicalMainOAuthOwner(params.provider)) {
    return params.agentDir;
  }
  const requestedPath = resolveAuthStorePath(params.agentDir);
  const mainPath = resolveAuthStorePath(undefined);
  return requestedPath === mainPath ? params.agentDir : undefined;
}

export function isCanonicalOAuthOwnerAgentDir(params: {
  provider: string;
  agentDir?: string;
}): boolean {
  return (
    resolveAuthStorePath(resolveCanonicalOAuthOwnerAgentDir(params)) ===
    resolveAuthStorePath(params.agentDir)
  );
}

export function shouldPersistCredentialInAgentStore(params: {
  credential: AuthProfileCredential;
  agentDir?: string;
}): boolean {
  if (params.credential.type !== "oauth") {
    return true;
  }
  return isCanonicalOAuthOwnerAgentDir({
    provider: params.credential.provider,
    agentDir: params.agentDir,
  });
}

export function stripNonOwnerCanonicalOAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
}): AuthProfileStore {
  const requestedPath = resolveAuthStorePath(params.agentDir);
  const mainPath = resolveAuthStorePath(undefined);
  if (!params.agentDir || requestedPath === mainPath) {
    return params.store;
  }

  let changed = false;
  const profiles = Object.fromEntries(
    Object.entries(params.store.profiles).flatMap(([profileId, credential]) => {
      if (
        credential.type === "oauth" &&
        hasCanonicalMainOAuthOwner(credential.provider) &&
        !isCanonicalOAuthOwnerAgentDir({ provider: credential.provider, agentDir: params.agentDir })
      ) {
        changed = true;
        return [];
      }
      return [[profileId, credential]];
    }),
  ) as AuthProfileStore["profiles"];

  if (!changed) {
    return params.store;
  }

  return {
    ...params.store,
    profiles,
  };
}
