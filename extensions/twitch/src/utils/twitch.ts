import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeTwitchChannel(channel: string): string {
  const trimmed = normalizeLowercaseStringOrEmpty(channel);
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
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
