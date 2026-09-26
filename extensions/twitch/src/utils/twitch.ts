import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Normalize Twitch channel names.
 *
 * Removes the '#' prefix if present, converts to lowercase, and trims whitespace.
 * Twitch channel names are case-insensitive and don't use the '#' prefix in the API.

 */
export function normalizeTwitchChannel(channel: string): string {
  const trimmed = normalizeLowercaseStringOrEmpty(channel);
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

/**
 * Normalize OAuth token by removing the "oauth:" prefix if present.
 *
 * Twurple doesn't require the "oauth:" prefix, so we strip it for consistency.

 */
export function normalizeToken(token: string): string {
  return token.startsWith("oauth:") ? token.slice(6) : token;
}

/**
 * Check if an account is properly configured with required credentials.

 */
export function isAccountConfigured(
  account: {
    username?: string;
    accessToken?: string;
    clientId?: string;
  },
  resolvedToken?: string | null,
): boolean {
  const token = resolvedToken ?? account?.accessToken;
  return Boolean(account?.username && token && account?.clientId);
}
