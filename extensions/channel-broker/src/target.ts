import {
  buildBrokerConversationTarget,
  normalizeBrokerPlatformId,
  parseBrokerConversationTarget,
  type BrokerConversationTarget,
  type BrokerConversationType,
} from "openclaw/plugin-sdk/channel-broker";
import { normalizeKnownChannelBrokerPlatformId } from "./platforms.js";
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
    const brokerPrefixed = parsed.platform === "broker" || parsed.platform === "channel-broker";
    if (brokerPrefixed) {
      return normalizeBrokerPrefixedTarget(trimmed, parsed);
    }
    const allowConversationTypeShorthand =
      !parsed.conversationType && rawTargetUsesConversationTypeShorthand(trimmed, brokerPrefixed);
    const colonParts = parsed.conversationId.split(":");
    const explicitType = allowConversationTypeShorthand
      ? normalizeConversationType(colonParts[0])
      : undefined;
    const rawId = explicitType ? colonParts.slice(1).join(":") : parsed.conversationId;
    const conversationId = rawId.trim();
    if (!conversationId) {
      return undefined;
    }
    return buildBrokerConversationTarget({
      platform: normalizeKnownChannelBrokerPlatformId(parsed.platform),
      conversationId,
      ...((explicitType ?? parsed.conversationType)
        ? { conversationType: explicitType ?? parsed.conversationType }
        : {}),
      ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
    });
  } catch {
    return undefined;
  }
}

function normalizeBrokerPrefixedTarget(
  rawTarget: string,
  parsed: BrokerConversationTarget,
): string | undefined {
  if (!parsed.conversationId.trim()) {
    return undefined;
  }
  const queryStart = rawTarget.indexOf("?");
  const head = queryStart < 0 ? rawTarget : rawTarget.slice(0, queryStart);
  const query = queryStart < 0 ? "" : rawTarget.slice(queryStart);
  const outerSeparator = head.indexOf(":");
  const rawInner = outerSeparator < 0 ? "" : head.slice(outerSeparator + 1);
  const innerSeparator = rawInner.indexOf(":");
  if (innerSeparator <= 0) {
    return rawTarget;
  }
  const platform = normalizeKnownChannelBrokerPlatformId(rawInner.slice(0, innerSeparator));
  return `${parsed.platform}:${platform}:${rawInner.slice(innerSeparator + 1)}${query}`;
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

function rawTargetUsesConversationTypeShorthand(
  rawTarget: string,
  brokerPrefixed: boolean,
): boolean {
  const withoutQuery = rawTarget.trim().split("?", 1)[0] ?? "";
  const platformSeparator = withoutQuery.indexOf(":");
  if (platformSeparator < 0) {
    return false;
  }
  let rawConversationId = withoutQuery.slice(platformSeparator + 1);
  if (brokerPrefixed) {
    const brokerPlatformSeparator = rawConversationId.indexOf(":");
    if (brokerPlatformSeparator <= 0) {
      return false;
    }
    rawConversationId = rawConversationId.slice(brokerPlatformSeparator + 1);
  }
  const typeSeparator = rawConversationId.indexOf(":");
  if (typeSeparator <= 0) {
    return false;
  }
  return Boolean(normalizeConversationType(rawConversationId.slice(0, typeSeparator)));
}

function inferTelegramChatTypeFromConversation(params: {
  conversationId: string;
  threadId?: string;
}): "direct" | "group" | "channel" | undefined {
  if (/^\d+$/.test(params.conversationId)) {
    return "direct";
  }
  if (params.threadId) {
    return "channel";
  }
  if (/^-\d+$/.test(params.conversationId)) {
    return "group";
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
    const rawPlatform =
      brokerPrefixed && parsed.conversationId.includes(":")
        ? parsed.conversationId.slice(0, parsed.conversationId.indexOf(":"))
        : parsed.platform;
    const usesConversationTypeShorthand = rawTargetUsesConversationTypeShorthand(
      rawTarget,
      brokerPrefixed,
    );
    if (!usesConversationTypeShorthand && normalizeBrokerPlatformId(rawPlatform) === "telegram") {
      const telegramConversation = parseTelegramTopicConversation(rawConversationId);
      const telegramType = inferTelegramChatTypeFromConversation({
        conversationId: telegramConversation.conversationId,
        threadId: parsed.threadId ?? telegramConversation.threadId,
      });
      if (telegramType) {
        return telegramType;
      }
    }
    if (!usesConversationTypeShorthand) {
      return "channel";
    }
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
    if (normalizeBrokerPlatformId(rawPlatform) === "telegram") {
      const telegramConversation = parseTelegramTopicConversation(rawConversationId);
      const telegramType = inferTelegramChatTypeFromConversation({
        conversationId: telegramConversation.conversationId,
        threadId: parsed.threadId ?? telegramConversation.threadId,
      });
      if (telegramType) {
        return telegramType;
      }
    }
    return "channel";
  } catch {
    return undefined;
  }
}

function parseTelegramTopicConversation(rawConversationId: string): {
  conversationId: string;
  threadId?: string;
  conversationType?: BrokerConversationType;
} {
  const topicMatch = /^(.*):topic:([^:]+)$/i.exec(rawConversationId);
  if (topicMatch?.[1] && topicMatch[2]) {
    return {
      conversationId: topicMatch[1],
      threadId: topicMatch[2],
    };
  }
  const numericTopicMatch = /^(-?\d+):(\d+)$/.exec(rawConversationId);
  if (numericTopicMatch?.[1] && numericTopicMatch[2]) {
    return {
      conversationId: numericTopicMatch[1],
      threadId: numericTopicMatch[2],
    };
  }
  return { conversationId: rawConversationId };
}

function parsePlatformConversation(params: { platform: string; rawConversationId: string }): {
  conversationId: string;
  threadId?: string;
  conversationType?: BrokerConversationType;
} {
  if (params.platform === "telegram") {
    return parseTelegramTopicConversation(params.rawConversationId);
  }
  return { conversationId: params.rawConversationId };
}

export function parseChannelBrokerTarget(params: {
  rawTarget: string;
  account: ResolvedChannelBrokerAccount;
  threadId?: string | number | null;
}): BrokerConversationTarget {
  const parsed = parseBrokerConversationTarget(params.rawTarget);
  const brokerPrefixed = parsed.platform === "broker" || parsed.platform === "channel-broker";
  const brokerPrefixSeparator = brokerPrefixed ? parsed.conversationId.indexOf(":") : -1;
  if (brokerPrefixed && brokerPrefixSeparator === 0) {
    throw new Error(`Invalid channel broker target: ${params.rawTarget}`);
  }
  if (brokerPrefixed && brokerPrefixSeparator < 0 && !params.account.defaultPlatform) {
    throw new Error("broker target must include a platform or configure defaultPlatform");
  }
  const rawPlatform =
    brokerPrefixed && brokerPrefixSeparator > 0
      ? parsed.conversationId.slice(0, brokerPrefixSeparator)
      : brokerPrefixed
        ? params.account.defaultPlatform
        : parsed.platform;
  const rawConversationId =
    brokerPrefixed && brokerPrefixSeparator > 0
      ? parsed.conversationId.slice(brokerPrefixSeparator + 1)
      : parsed.conversationId;
  if (!rawPlatform) {
    throw new Error(`Invalid channel broker target: ${params.rawTarget}`);
  }
  if (!rawConversationId.trim()) {
    throw new Error("broker conversation id is required");
  }
  const normalizedRawPlatform = normalizeBrokerPlatformId(rawPlatform);
  const platform =
    params.account.platformAliases[normalizedRawPlatform] ??
    normalizeKnownChannelBrokerPlatformId(rawPlatform);
  if (params.account.platforms.length > 0 && !params.account.platforms.includes(platform)) {
    throw new Error(
      `Channel broker provider ${params.account.providerId} does not support platform ${platform}.`,
    );
  }
  const allowConversationTypeShorthand =
    !parsed.conversationType &&
    rawTargetUsesConversationTypeShorthand(params.rawTarget, brokerPrefixed);
  const colonParts = rawConversationId.split(":");
  const explicitType = allowConversationTypeShorthand
    ? normalizeConversationType(colonParts[0])
    : undefined;
  const rawId = explicitType ? colonParts.slice(1).join(":") : rawConversationId;
  const platformConversation = parsePlatformConversation({
    platform,
    rawConversationId: rawId,
  });
  const conversationId = platformConversation.conversationId.trim();
  if (!conversationId) {
    throw new Error("broker conversation id is required");
  }
  const threadId =
    params.threadId == null
      ? (parsed.threadId ?? platformConversation.threadId)
      : String(params.threadId).trim() || parsed.threadId || platformConversation.threadId;
  const inferredType =
    platform === "telegram"
      ? inferTelegramChatTypeFromConversation({
          conversationId,
          ...(threadId ? { threadId } : {}),
        })
      : undefined;
  const configuredDefaultType = params.account.config.defaultConversationType;
  const threadedType = inferredType ?? (threadId ? "channel" : undefined);
  return {
    platform,
    conversationId,
    conversationType:
      explicitType ??
      parsed.conversationType ??
      platformConversation.conversationType ??
      (threadId ? threadedType : (configuredDefaultType ?? inferredType)) ??
      configuredDefaultType ??
      params.account.defaultConversationType,
    ...(threadId ? { threadId } : {}),
  };
}

export function buildCanonicalChannelBrokerTarget(params: {
  rawTarget: string;
  account: ResolvedChannelBrokerAccount;
  threadId?: string | number | null;
}): string {
  const parsed = parseBrokerConversationTarget(params.rawTarget);
  const target = parseChannelBrokerTarget(params);
  const canonicalTarget = buildBrokerConversationTarget(target);
  return parsed.platform === "broker" || parsed.platform === "channel-broker"
    ? `${parsed.platform}:${canonicalTarget}`
    : canonicalTarget;
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
