import {
  type ChatSenderAllowParams,
  createAllowedChatSenderMatcher,
  type ParsedChatTarget,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedChatTarget,
  resolveServicePrefixedOrChatAllowTarget,
} from "openclaw/plugin-sdk/channel-targets";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeIMessageHandleValue } from "./normalize.js";
import { normalizeBareIMessageChatIdentifier } from "./target-identifiers.js";

export type IMessageService = "imessage" | "sms" | "auto";

export type IMessageTarget =
  | ParsedChatTarget
  | { kind: "handle"; to: string; service: IMessageService; serviceExplicit?: boolean };

export type IMessageAllowTarget = ParsedChatTarget | { kind: "handle"; handle: string };

const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"];
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];
const CHAT_IDENTIFIER_PREFIXES = ["chat_identifier:", "chatidentifier:", "chatident:"];
const SERVICE_PREFIXES: Array<{ prefix: string; service: IMessageService }> = [
  { prefix: "imessage:", service: "imessage" },
  { prefix: "sms:", service: "sms" },
  { prefix: "auto:", service: "auto" },
];

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
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  for (const { prefix } of SERVICE_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      return normalizeIMessageHandle(trimmed.slice(prefix.length));
    }
  }

  for (const [kind, prefixes] of [
    ["chat_id", CHAT_ID_PREFIXES],
    ["chat_guid", CHAT_GUID_PREFIXES],
    ["chat_identifier", CHAT_IDENTIFIER_PREFIXES],
  ] as const) {
    for (const prefix of prefixes) {
      if (lowered.startsWith(prefix)) {
        return `${kind}:${trimmed.slice(prefix.length).trim()}`;
      }
    }
  }

  return normalizeIMessageHandleValue(trimmed) ?? trimmed.replace(/\s+/g, "");
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
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
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
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
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
    CHAT_ID_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    CHAT_GUID_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    CHAT_IDENTIFIER_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
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
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
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
