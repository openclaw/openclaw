import {
  buildBrokerConversationTarget,
  normalizeBrokerPlatformId,
  parseBrokerConversationTarget,
  type BrokerConversationTarget,
  type BrokerConversationType,
} from "openclaw/plugin-sdk/channel-broker";
import type { ResolvedChannelBrokerAccount } from "./types.js";

const CONVERSATION_TYPE_PREFIXES = new Set(["direct", "group", "channel", "thread"]);

function normalizeConversationType(raw: string | undefined): BrokerConversationType | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  return CONVERSATION_TYPE_PREFIXES.has(normalized)
    ? (normalized as BrokerConversationType)
    : undefined;
}

export function normalizeBrokerTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = parseBrokerConversationTarget(trimmed);
    return buildBrokerConversationTarget(parsed);
  } catch {
    return trimmed;
  }
}

export function parseChannelBrokerTarget(params: {
  rawTarget: string;
  account: ResolvedChannelBrokerAccount;
  threadId?: string | number | null;
}): BrokerConversationTarget {
  const parsed = parseBrokerConversationTarget(params.rawTarget);
  const brokerPrefixed = parsed.platform === "broker" || parsed.platform === "channel-broker";
  const brokerPrefixSeparator = brokerPrefixed ? parsed.conversationId.indexOf(":") : -1;
  const rawPlatform =
    brokerPrefixed && brokerPrefixSeparator > 0
      ? parsed.conversationId.slice(0, brokerPrefixSeparator)
      : brokerPrefixed && params.account.defaultPlatform
        ? params.account.defaultPlatform
        : parsed.platform;
  const rawConversationId =
    brokerPrefixed && brokerPrefixSeparator > 0
      ? parsed.conversationId.slice(brokerPrefixSeparator + 1)
      : brokerPrefixed && params.account.defaultPlatform
        ? parsed.conversationId
        : parsed.conversationId;
  const platform =
    params.account.platformAliases[normalizeBrokerPlatformId(rawPlatform)] ??
    normalizeBrokerPlatformId(rawPlatform);
  const colonParts = rawConversationId.split(":");
  const explicitType = normalizeConversationType(colonParts[0]);
  const conversationId = explicitType ? colonParts.slice(1).join(":") : rawConversationId;
  const threadId =
    params.threadId == null ? parsed.threadId : String(params.threadId).trim() || parsed.threadId;
  return {
    platform,
    conversationId,
    conversationType:
      explicitType ?? parsed.conversationType ?? params.account.defaultConversationType,
    ...(threadId ? { threadId } : {}),
  };
}

export function resolveBrokerOutboundTo(params: {
  to?: string | null;
  account: ResolvedChannelBrokerAccount;
}): string | undefined {
  const explicit = params.to?.trim();
  if (explicit) {
    return normalizeBrokerTarget(explicit);
  }
  return params.account.defaultTo;
}
