import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeTwitchChannel(channel: string): string {
  const trimmed = normalizeLowercaseStringOrEmpty(channel);
  // Reply and durable targets carry the internal prefix (monitor.ts builds
  // `twitch:channel:<name>`); Twitch itself only accepts the bare name.
  const unprefixed = trimmed.startsWith("twitch:channel:")
    ? trimmed.slice("twitch:channel:".length)
    : trimmed;
  return unprefixed.startsWith("#") ? unprefixed.slice(1) : unprefixed;
}

// Twurple expects the token without the IRC oauth: prefix.
export function normalizeToken(token: string): string {
  return token.startsWith("oauth:") ? token.slice(6) : token;
}

export function isAccountConfigured(
  account: {
    username?: string;
    accessToken?: string;
    clientId?: string;
  },
  resolvedToken?: string | null,
): boolean {
  const token = resolvedToken ?? account.accessToken;
  return Boolean(account.username && token && account.clientId);
}
