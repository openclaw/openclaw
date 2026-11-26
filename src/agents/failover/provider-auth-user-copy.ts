import {
  AUTH_INVALID_TOKEN_USER_TEXT,
  renderMissingApiKeyReplyCopy,
  resolveProviderRequestFailureCopy,
} from "./user-copy.js";

// Provider-aware sign-in copy. It wraps the generic user-copy owner so a reply
// can name the provider and its own `/login` command when the id is known.

const SAFE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Only normalized provider ids are safe to embed in chat or shell guidance. */
export function resolveSafeProviderId(provider?: string): string | undefined {
  const normalized = provider?.trim().toLowerCase();
  return normalized && SAFE_PROVIDER_ID_RE.test(normalized) ? normalized : undefined;
}

/** Format sign-in failure copy with the provider's own recovery steps when known. */
export function formatProviderAuthenticationErrorUserText(provider?: string): string {
  const providerName = resolveSafeProviderId(provider);
  return providerName
    ? `Couldn't sign in to ${providerName}. Sign in again with /login ${providerName} or under Models in the OpenClaw app. For now, switch to a working model with /model.`
    : AUTH_INVALID_TOKEN_USER_TEXT;
}

/** Permanent auth failures (revoked key, deactivated account) are not a missing sign-in. */
export function formatProviderAuthPermanentErrorUserText(provider?: string): string {
  const providerName = resolveSafeProviderId(provider);
  return providerName
    ? `${providerName} isn't accepting your login. Reconnect it with /login ${providerName} or under Models in the OpenClaw app. For now, switch to a working model with /model.`
    : "The AI service isn't accepting your login. Sign in again under Models in the OpenClaw app or run `openclaw configure`.";
}

/** Provider request failure copy that names the provider on authentication failures. */
export function resolveProviderAwareRequestFailureCopy(
  params: Parameters<typeof resolveProviderRequestFailureCopy>[0] & { provider?: string },
) {
  const copy = resolveProviderRequestFailureCopy(params);
  return copy?.code === "provider_authentication_error"
    ? { ...copy, userMessage: `⚠️ ${formatProviderAuthenticationErrorUserText(params.provider)}` }
    : copy;
}

/** Missing-credential copy that names a known provider and its `/login` command. */
export function renderProviderAwareMissingApiKeyReplyCopy(
  params?: Parameters<typeof renderMissingApiKeyReplyCopy>[0],
): string | null {
  const safeProvider = resolveSafeProviderId(params?.provider);
  return safeProvider && safeProvider !== "openai"
    ? `⚠️ ${safeProvider} isn't signed in yet. Sign in with /login ${safeProvider} or under Models in the OpenClaw app. For now, switch to a working model with /model.`
    : renderMissingApiKeyReplyCopy(params);
}
