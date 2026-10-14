import {
  type ChatSenderAllowParams,
  createAllowedChatSenderMatcher,
  type ParsedChatTarget,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedChatTarget,
  resolveServicePrefixedOrChatAllowTarget,
} from "openclaw/plugin-sdk/channel-targets";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  IMESSAGE_CHAT_TARGET_PREFIXES,
  IMESSAGE_CHAT_TARGET_PREFIX_RE,
  IMESSAGE_SERVICE_PREFIXES as SERVICE_PREFIXES,
  normalizeIMessageHandleInput,
} from "./normalize.js";
import { normalizeBareIMessageChatIdentifier } from "./target-identifiers.js";

export type IMessageService = "imessage" | "sms" | "auto";

export type IMessageTarget =
  | ParsedChatTarget
  | { kind: "handle"; to: string; service: IMessageService; serviceExplicit?: boolean };

export type IMessageAllowTarget = ParsedChatTarget | { kind: "handle"; handle: string };

function parseServicePrefixedBareChatIdentifier(params: {
  trimmed: string;
  lower: string;
}): IMessageTarget | undefined {
  for (const { prefix } of SERVICE_PREFIXES) {
    if (!params.lower.startsWith(prefix)) {
      continue;
    }
    const chatIdentifier = normalizeBareIMessageChatIdentifier(params.trimmed.slice(prefix.length));
    if (chatIdentifier) {
      return { kind: "chat_identifier", chatIdentifier };
    }
  }
  return undefined;
}

export function normalizeIMessageHandle(raw: string): string {
  return normalizeIMessageHandleInput(raw, "sender");
}

export function parseIMessageTarget(raw: string): IMessageTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("iMessage target is required");
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);

  const servicePrefixedBareChatIdentifier = parseServicePrefixedBareChatIdentifier({
    trimmed,
    lower,
  });
  if (servicePrefixedBareChatIdentifier) {
    return servicePrefixedBareChatIdentifier;
  }

  const servicePrefixed = resolveServicePrefixedChatTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    ...IMESSAGE_CHAT_TARGET_PREFIXES,
    parseTarget: parseIMessageTarget,
  });
  if (servicePrefixed) {
    if (servicePrefixed.kind === "handle") {
      return { ...servicePrefixed, serviceExplicit: true };
    }
    return servicePrefixed;
  }

  const chatTarget = parseChatTargetPrefixesOrThrow({
    trimmed,
    lower,
    ...IMESSAGE_CHAT_TARGET_PREFIXES,
  });
  if (chatTarget) {
    return chatTarget;
  }

  const bareChatIdentifier = normalizeBareIMessageChatIdentifier(trimmed);
  if (bareChatIdentifier) {
    return { kind: "chat_identifier", chatIdentifier: bareChatIdentifier };
  }

  return { kind: "handle", to: trimmed, service: "auto" };
}

export function looksLikeIMessageExplicitTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (/^(imessage:|sms:|auto:)/.test(lower)) {
    return true;
  }
  return (
    IMESSAGE_CHAT_TARGET_PREFIX_RE.test(lower) ||
    Boolean(normalizeBareIMessageChatIdentifier(trimmed))
  );
}

export function inferIMessageTargetChatType(raw: string): "direct" | "group" | undefined {
  try {
    const parsed = parseIMessageTarget(raw);
    if (parsed.kind === "handle") {
      return "direct";
    }
    return "group";
  } catch {
    return undefined;
  }
}

export function parseIMessageAllowTarget(raw: string): IMessageAllowTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: "handle", handle: "" };
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);

  const servicePrefixed = resolveServicePrefixedOrChatAllowTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    parseAllowTarget: parseIMessageAllowTarget,
    ...IMESSAGE_CHAT_TARGET_PREFIXES,
  });
  if (servicePrefixed) {
    return servicePrefixed;
  }

  return { kind: "handle", handle: normalizeIMessageHandle(trimmed) };
}

const isAllowedIMessageSenderMatcher = createAllowedChatSenderMatcher({
  normalizeSender: normalizeIMessageHandle,
  parseAllowTarget: parseIMessageAllowTarget,
  allowConversationTargets: false,
});

export function isAllowedIMessageSender(params: ChatSenderAllowParams): boolean {
  return isAllowedIMessageSenderMatcher({ ...params, allowConversationTargets: false });
}

export const isAllowedIMessageReplyContextSender = createAllowedChatSenderMatcher({
  normalizeSender: normalizeIMessageHandle,
  parseAllowTarget: parseIMessageAllowTarget,
  allowConversationTargets: true,
});

export function formatIMessageChatTarget(chatId?: number | null): string {
  if (!chatId || !Number.isFinite(chatId)) {
    return "";
  }
  return `chat_id:${chatId}`;
}
