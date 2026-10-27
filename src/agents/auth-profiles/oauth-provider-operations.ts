import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getOAuthProviders, type OAuthCredentials } from "../../llm/oauth.js";
import { OAuthProviderConfiguredUnavailableError } from "../../plugins/provider-runtime.errors.js";
import {
  formatProviderAuthProfileApiKeyWithPlugin,
  resolveProviderOAuthCredentialWithPlugin,
  resolveProviderOAuthRefreshCapabilityWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";
import type { OAuthCredential } from "./types.js";

const OAUTH_PROVIDERS = new Map(getOAuthProviders().map((provider) => [provider.id, provider]));

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

  const provider = OAUTH_PROVIDERS.get(credential.provider);
  if (!provider) {
    return null;
  }
  try {
    return await provider.refreshToken(credential);
  } catch (error) {
    throw new Error(`Failed to refresh OAuth token for ${credential.provider}`, { cause: error });
  }
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
  return OAUTH_PROVIDERS.has(provider);
}
