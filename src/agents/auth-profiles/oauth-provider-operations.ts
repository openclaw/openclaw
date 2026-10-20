import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getOAuthApiKey, getOAuthProviders, type OAuthCredentials } from "../../llm/oauth.js";
import { OAuthProviderConfiguredUnavailableError } from "../../plugins/provider-runtime.errors.js";
import {
  formatProviderAuthProfileApiKeyWithPlugin,
  resolveProviderOAuthCredentialWithPlugin,
  resolveProviderOAuthRefreshCapabilityWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";
import type { OAuthCredential } from "./types.js";

const OAUTH_PROVIDER_IDS = new Set<string>(getOAuthProviders().map((provider) => provider.id));

export async function refreshOAuthCredential(
  credential: OAuthCredential,
  context: { cfg?: OpenClawConfig } = {},
): Promise<OAuthCredentials | null> {
  const pluginResult = await resolveProviderOAuthCredentialWithPlugin({
    provider: credential.provider,
    config: context.cfg,
    credential,
    refresh: true,
  });
  if (pluginResult.status === "available") {
    return pluginResult.credential;
  }
  if (pluginResult.status === "configured-unavailable") {
    throw new OAuthProviderConfiguredUnavailableError(credential.provider);
  }

  if (!OAUTH_PROVIDER_IDS.has(credential.provider)) {
    return null;
  }
  const result = await getOAuthApiKey(credential.provider, {
    [credential.provider]: credential,
  });
  return result?.newCredentials ?? null;
}

export async function buildOAuthApiKey(
  credential: OAuthCredential,
  cfg?: OpenClawConfig,
): Promise<string> {
  const formatted = await formatProviderAuthProfileApiKeyWithPlugin({
    provider: credential.provider,
    config: cfg,
    context: credential,
  });
  return typeof formatted === "string" && formatted.length > 0 ? formatted : credential.access;
}

export async function canRefreshOAuthCredential(
  provider: string,
  cfg?: OpenClawConfig,
): Promise<boolean> {
  const capability = await resolveProviderOAuthRefreshCapabilityWithPlugin({
    provider,
    config: cfg,
  });
  if (capability.status === "available") {
    return true;
  }
  if (capability.status === "configured-unavailable") {
    throw new OAuthProviderConfiguredUnavailableError(provider);
  }
  return OAUTH_PROVIDER_IDS.has(provider);
}
