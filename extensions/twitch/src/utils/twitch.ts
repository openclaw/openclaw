import { stripChannelTargetPrefix } from "openclaw/plugin-sdk/channel-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeTwitchChannel(channel: string): string {
  const trimmed = normalizeLowercaseStringOrEmpty(channel);
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

// One normalizer for every Twitch messaging target form: bare channel names,
// #names, and twitch:/twitch-chat: provider targets with an optional kind
// prefix. Direct-message kinds are unsupported and normalize to empty so
// callers reject them instead of delivering to the wrong channel.
export function normalizeTwitchMessagingTarget(target: string): string {
  const providerTarget = stripChannelTargetPrefix(target, "twitch", "twitch-chat");
  const kindMatch = /^(user|dm|channel|group|conversation|room):/i.exec(providerTarget);
  const kind = kindMatch?.[1]?.toLowerCase();
  if (kind === "user" || kind === "dm") {
    return "";
  }
  const channelTarget = kindMatch ? providerTarget.slice(kindMatch[0].length) : providerTarget;
  return normalizeTwitchChannel(channelTarget);
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
