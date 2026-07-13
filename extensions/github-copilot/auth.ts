// Github Copilot plugin module implements auth behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderPrepareDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  coerceSecretRef,
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import {
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";
import { PROVIDER_ID } from "./models.js";

export async function resolveFirstGithubToken(params: {
  agentDir?: string;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  profileId?: string;
  authProfileMode?: ProviderPrepareDynamicModelContext["authProfileMode"];
}): Promise<{
  githubToken: string;
  hasProfile: boolean;
}> {
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileIds = listProfilesForProvider(authStore, PROVIDER_ID);
  const hasProfile = profileIds.length > 0;
  const requestedProfileId = params.profileId?.trim();
  const envToken =
    params.env.COPILOT_GITHUB_TOKEN ?? params.env.GH_TOKEN ?? params.env.GITHUB_TOKEN ?? "";
  const githubToken = envToken.trim();
  if (!requestedProfileId && params.authProfileMode) {
    if (!params.config) {
      return { githubToken, hasProfile: false };
    }
    // A missing profile id plus an explicit mode is a prepared direct-auth
    // attempt. Do not let it fall back into the first stored profile: model
    // limits and the later runtime exchange must use the same source token.
    // Stored profiles are therefore ineligible even when the store has one.
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: params.config,
      env: params.env,
      value: params.config.models?.providers?.[PROVIDER_ID]?.apiKey,
      path: `models.providers.${PROVIDER_ID}.apiKey`,
      readFallback: () => githubToken,
    });
    return { githubToken: resolved.value?.trim() ?? "", hasProfile: false };
  }
  if (!requestedProfileId && (githubToken || !hasProfile)) {
    return { githubToken, hasProfile };
  }

  const profileId = requestedProfileId
    ? profileIds.find((candidate) => candidate === requestedProfileId)
    : profileIds[0];
  const profile = profileId ? authStore.profiles[profileId] : undefined;
  if (profile?.type !== "token") {
    return { githubToken: "", hasProfile };
  }
  const directToken = profile.token?.trim() ?? "";
  if (directToken) {
    return { githubToken: directToken, hasProfile };
  }
  const tokenRef = coerceSecretRef(profile.tokenRef);
  if (tokenRef?.source === "env" && tokenRef.id.trim()) {
    return {
      githubToken: (params.env[tokenRef.id] ?? process.env[tokenRef.id] ?? "").trim(),
      hasProfile,
    };
  }

  if (tokenRef && params.config) {
    try {
      const resolved = await resolveRequiredConfiguredSecretRefInputString({
        config: params.config,
        env: params.env,
        value: profile.tokenRef,
        path: `providers.github-copilot.authProfiles.${profileId ?? "default"}.tokenRef`,
      });
      return {
        githubToken: resolved?.trim() ?? "",
        hasProfile,
      };
    } catch {
      return { githubToken: "", hasProfile };
    }
  }

  return { githubToken: "", hasProfile };
}
