import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderPrepareDynamicModelContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  coerceSecretRef,
  ensureAuthProfileStoreAsync,
  listProfilesForProvider,
  normalizeOptionalSecretInput,
  resolveAuthProfileOrder,
} from "openclaw/plugin-sdk/provider-auth";
import {
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";
import { PUBLIC_GITHUB_COPILOT_DOMAIN } from "./domain.js";
import { PROVIDER_ID } from "./models.js";
import { formatGithubCopilotApiKey, parseGithubCopilotApiKey } from "./oauth.js";

export async function resolveFirstGithubToken(params: {
  agentDir?: string;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  profileId?: string;
  authProfileMode?: ProviderPrepareDynamicModelContext["authProfileMode"];
}): Promise<{
  githubToken: string;
  githubDomain?: string;
  profileId?: string;
}> {
  const authStore = await ensureAuthProfileStoreAsync(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileIds = listProfilesForProvider(authStore, PROVIDER_ID);
  const hasProfile = profileIds.length > 0;
  const requestedProfileId = params.profileId?.trim();
  const githubToken = normalizeOptionalSecretInput(params.env.COPILOT_GITHUB_TOKEN) ?? "";
  const providerConfig = params.config?.models?.providers?.[PROVIDER_ID];
  const configuredRefCanOwnAuth =
    providerConfig?.auth === undefined ||
    providerConfig.auth === "api-key" ||
    providerConfig.auth === "token";
  const preferConfiguredToken =
    (configuredRefCanOwnAuth &&
      Boolean(coerceSecretRef(providerConfig?.apiKey, params.config?.secrets?.defaults))) ||
    (providerConfig?.auth === "api-key" &&
      Boolean(normalizeOptionalSecretInput(providerConfig.apiKey)));
  if (
    !requestedProfileId &&
    (params.authProfileMode || preferConfiguredToken || githubToken || !hasProfile)
  ) {
    // Prepared direct-auth attempts must not borrow a stored profile: model
    // limits and the later runtime exchange must use the same source token.
    if (githubToken && !preferConfiguredToken) {
      return { githubToken };
    }
    if (!params.config) {
      return { githubToken: "" };
    }
    const resolved = await resolveConfiguredSecretInputWithFallback({
      config: params.config,
      env: params.env,
      value: configuredRefCanOwnAuth
        ? providerConfig?.apiKey
        : normalizeOptionalSecretInput(providerConfig?.apiKey),
      path: `models.providers.${PROVIDER_ID}.apiKey`,
      readFallback: () => "",
    });
    if (resolved.secretRefConfigured && !resolved.value) {
      throw new Error(
        resolved.unresolvedRefReason ??
          `models.providers.${PROVIDER_ID}.apiKey SecretRef is unresolved.`,
      );
    }
    return { githubToken: resolved.value?.trim() || githubToken };
  }

  // Discovery must use the same eligibility and account order as inference.
  // An abandoned setup profile must not hide a later usable saved sign-in.
  const profileId = requestedProfileId
    ? profileIds.find((candidate) => candidate === requestedProfileId)
    : resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider: PROVIDER_ID,
      })[0];
  const profile = profileId ? authStore.profiles[profileId] : undefined;
  if (profile?.type === "oauth") {
    const formatted = formatGithubCopilotApiKey(profile);
    if (!normalizeOptionalSecretInput(profile.refresh)) {
      return { githubToken: "" };
    }
    const parsed = parseGithubCopilotApiKey(formatted);
    return {
      ...parsed,
      githubDomain: parsed.githubDomain ?? PUBLIC_GITHUB_COPILOT_DOMAIN,
      profileId,
    };
  }
  if (profile?.type !== "token") {
    return { githubToken: "" };
  }
  const resolved = await resolveRequiredConfiguredSecretRefInputString({
    config: params.config ?? {},
    env: params.env,
    value: profile.tokenRef,
    path: `providers.github-copilot.authProfiles.${profileId ?? "default"}.tokenRef`,
  });
  return { githubToken: (resolved ?? profile.token ?? "").trim(), profileId };
}
