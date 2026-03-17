import {
  isAllowedParsedChatSender,
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedTarget
} from "openclaw/plugin-sdk/bluebubbles";
const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"];
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];
const CHAT_IDENTIFIER_PREFIXES = ["chat_identifier:", "chatidentifier:", "chatident:"];
const SERVICE_PREFIXES = [
  { prefix: "imessage:", service: "imessage" },
  { prefix: "sms:", service: "sms" },
  { prefix: "auto:", service: "auto" }
];
const CHAT_IDENTIFIER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_IDENTIFIER_HEX_RE = /^[0-9a-f]{24,64}$/i;
function parseRawChatGuid(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(";");
  if (parts.length !== 3) {
    return null;
  }
  const service = parts[0]?.trim();
  const separator = parts[1]?.trim();
  const identifier = parts[2]?.trim();
  if (!service || !identifier) {
    return null;
  }
  if (separator !== "+" && separator !== "-") {
    return null;
  }
  return `${service};${separator};${identifier}`;
}
function stripPrefix(value, prefix) {
  return value.slice(prefix.length).trim();
}
function stripBlueBubblesPrefix(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!trimmed.toLowerCase().startsWith("bluebubbles:")) {
    return trimmed;
  }
  return trimmed.slice("bluebubbles:".length).trim();
}
function looksLikeRawChatIdentifier(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^chat\d+$/i.test(trimmed)) {
    return true;
  }
  return CHAT_IDENTIFIER_UUID_RE.test(trimmed) || CHAT_IDENTIFIER_HEX_RE.test(trimmed);
}
function parseGroupTarget(params) {
  if (!params.lower.startsWith("group:")) {
    return null;
  }
  const value = stripPrefix(params.trimmed, "group:");
  const chatId = Number.parseInt(value, 10);
  if (Number.isFinite(chatId)) {
    return { kind: "chat_id", chatId };
  }
  if (value) {
    return { kind: "chat_guid", chatGuid: value };
  }
  if (params.requireValue) {
    throw new Error("group target is required");
  }
  return null;
}
function parseRawChatIdentifierTarget(trimmed) {
  if (/^chat\d+$/i.test(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }
  if (looksLikeRawChatIdentifier(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }
  return null;
}
function normalizeBlueBubblesHandle(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("imessage:")) {
    return normalizeBlueBubblesHandle(trimmed.slice(9));
  }
  if (lowered.startsWith("sms:")) {
    return normalizeBlueBubblesHandle(trimmed.slice(4));
  }
  if (lowered.startsWith("auto:")) {
    return normalizeBlueBubblesHandle(trimmed.slice(5));
  }
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }
  return trimmed.replace(/\s+/g, "");
}
function extractHandleFromChatGuid(chatGuid) {
  const parts = chatGuid.split(";");
  if (parts.length === 3 && parts[1] === "-") {
    const handle = parts[2]?.trim();
    if (handle) {
      return normalizeBlueBubblesHandle(handle);
    }
  }
  return null;
}
function normalizeBlueBubblesMessagingTarget(raw) {
  let trimmed = raw.trim();
  if (!trimmed) {
    return void 0;
  }
  trimmed = stripBlueBubblesPrefix(trimmed);
  if (!trimmed) {
    return void 0;
  }
  try {
    const parsed = parseBlueBubblesTarget(trimmed);
    if (parsed.kind === "chat_id") {
      return `chat_id:${parsed.chatId}`;
    }
    if (parsed.kind === "chat_guid") {
      const handle2 = extractHandleFromChatGuid(parsed.chatGuid);
      if (handle2) {
        return handle2;
      }
      return `chat_guid:${parsed.chatGuid}`;
    }
    if (parsed.kind === "chat_identifier") {
      return `chat_identifier:${parsed.chatIdentifier}`;
    }
    const handle = normalizeBlueBubblesHandle(parsed.to);
    if (!handle) {
      return void 0;
    }
    return parsed.service === "auto" ? handle : `${parsed.service}:${handle}`;
  } catch {
    return trimmed;
  }
}
function looksLikeBlueBubblesTargetId(raw, normalized) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const candidate = stripBlueBubblesPrefix(trimmed);
  if (!candidate) {
    return false;
  }
  if (parseRawChatGuid(candidate)) {
    return true;
  }
  const lowered = candidate.toLowerCase();
  if (/^(imessage|sms|auto):/.test(lowered)) {
    return true;
  }
  if (/^(chat_id|chatid|chat|chat_guid|chatguid|guid|chat_identifier|chatidentifier|chatident|group):/.test(
    lowered
  )) {
    return true;
  }
  if (/^chat\d+$/i.test(candidate)) {
    return true;
  }
  if (looksLikeRawChatIdentifier(candidate)) {
    return true;
  }
  if (candidate.includes("@")) {
    return true;
  }
  const digitsOnly = candidate.replace(/[\s().-]/g, "");
  if (/^\+?\d{3,}$/.test(digitsOnly)) {
    return true;
  }
  if (normalized) {
    const normalizedTrimmed = normalized.trim();
    if (!normalizedTrimmed) {
      return false;
    }
    const normalizedLower = normalizedTrimmed.toLowerCase();
    if (/^(imessage|sms|auto):/.test(normalizedLower) || /^(chat_id|chat_guid|chat_identifier):/.test(normalizedLower)) {
      return true;
    }
  }
  return false;
}
function parseBlueBubblesTarget(raw) {
  const trimmed = stripBlueBubblesPrefix(raw);
  if (!trimmed) {
    throw new Error("BlueBubbles target is required");
  }
  const lower = trimmed.toLowerCase();
  const servicePrefixed = resolveServicePrefixedTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    isChatTarget: (remainderLower) => CHAT_ID_PREFIXES.some((p) => remainderLower.startsWith(p)) || CHAT_GUID_PREFIXES.some((p) => remainderLower.startsWith(p)) || CHAT_IDENTIFIER_PREFIXES.some((p) => remainderLower.startsWith(p)) || remainderLower.startsWith("group:"),
    parseTarget: parseBlueBubblesTarget
  });
  if (servicePrefixed) {
    return servicePrefixed;
  }
  const chatTarget = parseChatTargetPrefixesOrThrow({
    trimmed,
    lower,
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES
  });
  if (chatTarget) {
    return chatTarget;
  }
  const groupTarget = parseGroupTarget({ trimmed, lower, requireValue: true });
  if (groupTarget) {
    return groupTarget;
  }
  const rawChatGuid = parseRawChatGuid(trimmed);
  if (rawChatGuid) {
    return { kind: "chat_guid", chatGuid: rawChatGuid };
  }
  const rawChatIdentifierTarget = parseRawChatIdentifierTarget(trimmed);
  if (rawChatIdentifierTarget) {
    return rawChatIdentifierTarget;
  }
  return { kind: "handle", to: trimmed, service: "auto" };
}
function parseBlueBubblesAllowTarget(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: "handle", handle: "" };
  }
  const lower = trimmed.toLowerCase();
  const servicePrefixed = resolveServicePrefixedAllowTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    parseAllowTarget: parseBlueBubblesAllowTarget
  });
  if (servicePrefixed) {
    return servicePrefixed;
  }
  const chatTarget = parseChatAllowTargetPrefixes({
    trimmed,
    lower,
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES
  });
  if (chatTarget) {
    return chatTarget;
  }
  const groupTarget = parseGroupTarget({ trimmed, lower, requireValue: false });
  if (groupTarget) {
    return groupTarget;
  }
  const rawChatIdentifierTarget = parseRawChatIdentifierTarget(trimmed);
  if (rawChatIdentifierTarget) {
    return rawChatIdentifierTarget;
  }
  return { kind: "handle", handle: normalizeBlueBubblesHandle(trimmed) };
}
function isAllowedBlueBubblesSender(params) {
  return isAllowedParsedChatSender({
    allowFrom: params.allowFrom,
    sender: params.sender,
    chatId: params.chatId,
    chatGuid: params.chatGuid,
    chatIdentifier: params.chatIdentifier,
    normalizeSender: normalizeBlueBubblesHandle,
    parseAllowTarget: parseBlueBubblesAllowTarget
  });
}
function formatBlueBubblesChatTarget(params) {
  if (params.chatId && Number.isFinite(params.chatId)) {
    return `chat_id:${params.chatId}`;
  }
  const guid = params.chatGuid?.trim();
  if (guid) {
    return `chat_guid:${guid}`;
  }
  const identifier = params.chatIdentifier?.trim();
  if (identifier) {
    return `chat_identifier:${identifier}`;
  }
  return "";
}
export {
  extractHandleFromChatGuid,
  formatBlueBubblesChatTarget,
  isAllowedBlueBubblesSender,
  looksLikeBlueBubblesTargetId,
  normalizeBlueBubblesHandle,
  normalizeBlueBubblesMessagingTarget,
  parseBlueBubblesAllowTarget,
  parseBlueBubblesTarget
};
