import {
  buildBrokerConversationTarget,
  normalizeBrokerPlatformId,
  parseBrokerConversationTarget,
  type BrokerConversationTarget,
  type BrokerConversationType,
} from "openclaw/plugin-sdk/channel-broker";
import type { ResolvedChannelBrokerAccount } from "./types.js";

const CONVERSATION_TYPE_PREFIXES = new Set(["direct", "group", "channel", "thread"]);
const DIRECT_CONVERSATION_TYPE_ALIASES = new Set(["direct", "dm", "user"]);

function normalizeConversationType(raw: string | undefined): BrokerConversationType | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (DIRECT_CONVERSATION_TYPE_ALIASES.has(normalized)) {
    return "direct";
  }
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
    return undefined;
  }
}

function chatTypeFromConversationType(
  conversationType: BrokerConversationType | undefined,
): "direct" | "group" | "channel" | undefined {
  if (conversationType === "direct" || conversationType === "group") {
    return conversationType;
  }
  if (conversationType === "channel" || conversationType === "thread") {
    return "channel";
  }
  return undefined;
}

export function inferChannelBrokerTargetChatType(
  rawTarget: string,
): "direct" | "group" | "channel" | undefined {
  try {
    const parsed = parseBrokerConversationTarget(rawTarget);
    const parsedType = chatTypeFromConversationType(parsed.conversationType);
    if (parsedType) {
      return parsedType;
    }
    const brokerPrefixed = parsed.platform === "broker" || parsed.platform === "channel-broker";
    const rawConversationId =
      brokerPrefixed && parsed.conversationId.includes(":")
        ? parsed.conversationId.slice(parsed.conversationId.indexOf(":") + 1)
        : parsed.conversationId;
    const [rawType] = rawConversationId.split(":", 1);
    const type = rawType?.trim().toLowerCase();
    if (DIRECT_CONVERSATION_TYPE_ALIASES.has(type ?? "")) {
      return "direct";
    }
    if (type === "group") {
      return "group";
    }
    if (type === "channel" || type === "thread") {
      return "channel";
    }
    return "channel";
  } catch {
    return undefined;
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
  if (brokerPrefixed && brokerPrefixSeparator <= 0 && !params.account.defaultPlatform) {
    throw new Error("broker target must include a platform or configure defaultPlatform");
  }
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
  if (params.account.platforms.length > 0 && !params.account.platforms.includes(platform)) {
    throw new Error(
      `Channel broker provider ${params.account.providerId} does not support platform ${platform}.`,
    );
  }
  const colonParts = rawConversationId.split(":");
  const explicitType = normalizeConversationType(colonParts[0]);
  const rawId = explicitType ? colonParts.slice(1).join(":") : rawConversationId;
  const conversationId = rawId.trim();
  if (!conversationId) {
    throw new Error("broker conversation id is required");
  }
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
