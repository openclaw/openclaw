import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isIMessagePhoneLikeHandle,
  normalizeBareIMessageChatIdentifier,
} from "./target-identifiers.js";

export const IMESSAGE_SERVICE_PREFIXES = (["imessage", "sms", "auto"] as const).map((service) => ({
  service,
  prefix: `${service}:`,
}));
export const IMESSAGE_CHAT_TARGET_PREFIXES = {
  chatIdPrefixes: ["chat_id:", "chatid:", "chat:"],
  chatGuidPrefixes: ["chat_guid:", "chatguid:", "guid:"],
  chatIdentifierPrefixes: ["chat_identifier:", "chatidentifier:", "chatident:"],
};
export const IMESSAGE_CHAT_TARGET_PREFIX_RE = new RegExp(
  `^(${Object.values(IMESSAGE_CHAT_TARGET_PREFIXES).flat().join("|")})`,
  "i",
);

function normalizeIMessageHandleValue(trimmed: string): string | undefined {
  if (trimmed.includes("@")) {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
  const bareChatIdentifier = normalizeBareIMessageChatIdentifier(trimmed);
  if (bareChatIdentifier) {
    return `chat_identifier:${bareChatIdentifier}`;
  }
  const normalized = isIMessagePhoneLikeHandle(trimmed) ? normalizeE164(trimmed) : "";
  if (normalized) {
    return normalized;
  }
  return undefined;
}

export function normalizeIMessageHandleInput(
  raw: string,
  mode: "sender" | "target",
  allowContactName = false,
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  for (const { prefix } of IMESSAGE_SERVICE_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      return normalizeIMessageHandleInput(trimmed.slice(prefix.length), mode);
    }
  }
  const prefix = trimmed.match(IMESSAGE_CHAT_TARGET_PREFIX_RE)?.[0];
  if (prefix) {
    const value = trimmed.slice(prefix.length).trim();
    const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
    const canonicalPrefix = IMESSAGE_CHAT_TARGET_PREFIXES.chatIdPrefixes.includes(normalizedPrefix)
      ? "chat_id:"
      : IMESSAGE_CHAT_TARGET_PREFIXES.chatGuidPrefixes.includes(normalizedPrefix)
        ? "chat_guid:"
        : "chat_identifier:";
    return `${mode === "sender" ? canonicalPrefix : normalizedPrefix}${value}`;
  }
  return (
    normalizeIMessageHandleValue(trimmed) ??
    (mode === "sender" || allowContactName ? trimmed.replace(/\s+/g, "") : "")
  );
}

export function normalizeIMessageMessagingTarget(raw: string): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }

  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  for (const { prefix } of IMESSAGE_SERVICE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const remainder = trimmed.slice(prefix.length).trim();
      const normalizedHandle = normalizeIMessageHandleInput(remainder, "target", true);
      if (!normalizedHandle) {
        return undefined;
      }
      if (IMESSAGE_CHAT_TARGET_PREFIX_RE.test(normalizedHandle)) {
        return normalizedHandle;
      }
      return `${prefix}${normalizedHandle}`;
    }
  }

  const normalized = normalizeIMessageHandleInput(trimmed, "target");
  return normalized || undefined;
}

export function looksLikeIMessageTargetId(raw: string): boolean {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return false;
  }
  if (IMESSAGE_CHAT_TARGET_PREFIX_RE.test(trimmed)) {
    return true;
  }
  if (normalizeBareIMessageChatIdentifier(trimmed)) {
    return true;
  }
  return (
    /^(imessage:|sms:|auto:)/i.test(trimmed) ||
    trimmed.includes("@") ||
    (isIMessagePhoneLikeHandle(trimmed) && Boolean(normalizeE164(trimmed)))
  );
}
