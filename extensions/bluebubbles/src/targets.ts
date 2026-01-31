export type BlueBubblesService = "imessage" | "sms" | "auto";

export type BlueBubblesTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; to: string; service: BlueBubblesService };

export type BlueBubblesAllowTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; handle: string };

const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"];
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];
const CHAT_IDENTIFIER_PREFIXES = ["chat_identifier:", "chatidentifier:", "chatident:"];
const SERVICE_PREFIXES: Array<{ prefix: string; service: BlueBubblesService }> = [
  { prefix: "imessage:", service: "imessage" },
  { prefix: "sms:", service: "sms" },
  { prefix: "auto:", service: "auto" },
];
const CHAT_IDENTIFIER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_IDENTIFIER_HEX_RE = /^[0-9a-f]{24,64}$/i;

function parseRawChatGuid(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(";");
  if (parts.length !== 3) return null;
  const service = parts[0]?.trim();
  const separator = parts[1]?.trim();
  const identifier = parts[2]?.trim();
  if (!service || !identifier) return null;
  if (separator !== "+" && separator !== "-") return null;
  return `${service};${separator};${identifier}`;
}

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

function stripBlueBubblesPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!trimmed.toLowerCase().startsWith("bluebubbles:")) return trimmed;
  return trimmed.slice("bluebubbles:".length).trim();
}

function looksLikeRawChatIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^chat\d+$/i.test(trimmed)) return true;
  return CHAT_IDENTIFIER_UUID_RE.test(trimmed) || CHAT_IDENTIFIER_HEX_RE.test(trimmed);
}

export function normalizeBlueBubblesHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("imessage:")) return normalizeBlueBubblesHandle(trimmed.slice(9));
  if (lowered.startsWith("sms:")) return normalizeBlueBubblesHandle(trimmed.slice(4));
  if (lowered.startsWith("auto:")) return normalizeBlueBubblesHandle(trimmed.slice(5));
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  return trimmed.replace(/\s+/g, "");
}

/**
 * Extracts the handle from a chat_guid if it's a DM (1:1 chat).
 * BlueBubbles chat_guid format for DM: "service;-;handle" (e.g., "iMessage;-;+19257864429")
 * Group chat format: "service;+;groupId" (has "+" instead of "-")
 */
export function extractHandleFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  // DM format: service;-;handle (3 parts, middle is "-")
  if (parts.length === 3 && parts[1] === "-") {
    const handle = parts[2]?.trim();
    if (handle) return normalizeBlueBubblesHandle(handle);
  }
  return null;
}

export function normalizeBlueBubblesMessagingTarget(raw: string): string | undefined {
  let trimmed = raw.trim();
  if (!trimmed) return undefined;
  trimmed = stripBlueBubblesPrefix(trimmed);
  if (!trimmed) return undefined;
  try {
    const parsed = parseBlueBubblesTarget(trimmed);
    if (parsed.kind === "chat_id") return `chat_id:${parsed.chatId}`;
    if (parsed.kind === "chat_guid") {
      // For DM chat_guids, normalize to just the handle for easier comparison.
      // This allows "chat_guid:iMessage;-;+1234567890" to match "+1234567890".
      const handle = extractHandleFromChatGuid(parsed.chatGuid);
      if (handle) return handle;
      // For group chats or unrecognized formats, keep the full chat_guid
      return `chat_guid:${parsed.chatGuid}`;
    }
    if (parsed.kind === "chat_identifier") return `chat_identifier:${parsed.chatIdentifier}`;
    const handle = normalizeBlueBubblesHandle(parsed.to);
    if (!handle) return undefined;
    return parsed.service === "auto" ? handle : `${parsed.service}:${handle}`;
  } catch {
    return trimmed;
  }
}

export function looksLikeBlueBubblesTargetId(raw: string, normalized?: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const candidate = stripBlueBubblesPrefix(trimmed);
  if (!candidate) return false;
  if (parseRawChatGuid(candidate)) return true;
  const lowered = candidate.toLowerCase();
  if (/^(imessage|sms|auto):/.test(lowered)) return true;
  if (
    /^(chat_id|chatid|chat|chat_guid|chatguid|guid|chat_identifier|chatidentifier|chatident|group):/.test(
      lowered,
    )
  ) {
    return true;
  }
  // Recognize chat<digits> patterns (e.g., "chat660250192681427962") as chat IDs
  if (/^chat\d+$/i.test(candidate)) return true;
  if (looksLikeRawChatIdentifier(candidate)) return true;
  if (candidate.includes("@")) return true;
  const digitsOnly = candidate.replace(/[\s().-]/g, "");
  if (/^\+?\d{3,}$/.test(digitsOnly)) return true;
  if (normalized) {
    const normalizedTrimmed = normalized.trim();
    if (!normalizedTrimmed) return false;
    const normalizedLower = normalizedTrimmed.toLowerCase();
    if (
      /^(imessage|sms|auto):/.test(normalizedLower) ||
      /^(chat_id|chat_guid|chat_identifier):/.test(normalizedLower)
    ) {
      return true;
    }
  }
  return false;
}

export function parseBlueBubblesTarget(raw: string): BlueBubblesTarget {
  const trimmed = stripBlueBubblesPrefix(raw);
  if (!trimmed) throw new Error("BlueBubbles target is required");
  const lower = trimmed.toLowerCase();

  for (const { prefix, service } of SERVICE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const remainder = stripPrefix(trimmed, prefix);
      if (!remainder) throw new Error(`${prefix} target is required`);
      const remainderLower = remainder.toLowerCase();
      const isChatTarget =
        CHAT_ID_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
        CHAT_GUID_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
        CHAT_IDENTIFIER_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
        remainderLower.startsWith("group:");
      if (isChatTarget) {
        return parseBlueBubblesTarget(remainder);
      }
      return { kind: "handle", to: remainder, service };
    }
  }

  for (const prefix of CHAT_ID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (!Number.isFinite(chatId)) {
        throw new Error(`Invalid chat_id: ${value}`);
      }
      return { kind: "chat_id", chatId };
    }
  }

  for (const prefix of CHAT_GUID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (!value) throw new Error("chat_guid is required");
      return { kind: "chat_guid", chatGuid: value };
    }
  }

  for (const prefix of CHAT_IDENTIFIER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (!value) throw new Error("chat_identifier is required");
      return { kind: "chat_identifier", chatIdentifier: value };
    }
  }

  if (lower.startsWith("group:")) {
    const value = stripPrefix(trimmed, "group:");
    const chatId = Number.parseInt(value, 10);
    if (Number.isFinite(chatId)) {
      return { kind: "chat_id", chatId };
    }
    if (!value) throw new Error("group target is required");
    return { kind: "chat_guid", chatGuid: value };
  }

  const rawChatGuid = parseRawChatGuid(trimmed);
  if (rawChatGuid) {
    return { kind: "chat_guid", chatGuid: rawChatGuid };
  }

  // Handle chat<digits> pattern (e.g., "chat660250192681427962") as chat_identifier
  // These are BlueBubbles chat identifiers (the third part of a chat GUID), not numeric IDs
  if (/^chat\d+$/i.test(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }

  // Handle UUID/hex chat identifiers (e.g., "8b9c1a10536d4d86a336ea03ab7151cc")
  if (looksLikeRawChatIdentifier(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }

  return { kind: "handle", to: trimmed, service: "auto" };
}

export function parseBlueBubblesAllowTarget(raw: string): BlueBubblesAllowTarget {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "handle", handle: "" };
  const lower = trimmed.toLowerCase();

  for (const { prefix } of SERVICE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const remainder = stripPrefix(trimmed, prefix);
      if (!remainder) return { kind: "handle", handle: "" };
      return parseBlueBubblesAllowTarget(remainder);
    }
  }

  for (const prefix of CHAT_ID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (Number.isFinite(chatId)) return { kind: "chat_id", chatId };
    }
  }

  for (const prefix of CHAT_GUID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (value) return { kind: "chat_guid", chatGuid: value };
    }
  }

  for (const prefix of CHAT_IDENTIFIER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (value) return { kind: "chat_identifier", chatIdentifier: value };
    }
  }

  if (lower.startsWith("group:")) {
    const value = stripPrefix(trimmed, "group:");
    const chatId = Number.parseInt(value, 10);
    if (Number.isFinite(chatId)) return { kind: "chat_id", chatId };
    if (value) return { kind: "chat_guid", chatGuid: value };
  }

  // Handle chat<digits> pattern (e.g., "chat660250192681427962") as chat_identifier
  // These are BlueBubbles chat identifiers (the third part of a chat GUID), not numeric IDs
  if (/^chat\d+$/i.test(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }

  // Handle UUID/hex chat identifiers (e.g., "8b9c1a10536d4d86a336ea03ab7151cc")
  if (looksLikeRawChatIdentifier(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }

  return { kind: "handle", handle: normalizeBlueBubblesHandle(trimmed) };
}

export function isAllowedBlueBubblesSender(params: {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): boolean {
  const allowFrom = params.allowFrom.map((entry) => String(entry).trim());
  if (allowFrom.length === 0) return true;
  if (allowFrom.includes("*")) return true;

  const senderNormalized = normalizeBlueBubblesHandle(params.sender);
  const chatId = params.chatId ?? undefined;
  const chatGuid = params.chatGuid?.trim();
  const chatIdentifier = params.chatIdentifier?.trim();

  for (const entry of allowFrom) {
    if (!entry) continue;
    const parsed = parseBlueBubblesAllowTarget(entry);
    if (parsed.kind === "chat_id" && chatId !== undefined) {
      if (parsed.chatId === chatId) return true;
    } else if (parsed.kind === "chat_guid" && chatGuid) {
      if (parsed.chatGuid === chatGuid) return true;
    } else if (parsed.kind === "chat_identifier" && chatIdentifier) {
      if (parsed.chatIdentifier === chatIdentifier) return true;
    } else if (parsed.kind === "handle" && senderNormalized) {
      if (parsed.handle === senderNormalized) return true;
    }
  }
  return false;
}

export function formatBlueBubblesChatTarget(params: {
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): string {
  if (params.chatId && Number.isFinite(params.chatId)) {
    return `chat_id:${params.chatId}`;
  }
  const guid = params.chatGuid?.trim();
  if (guid) return `chat_guid:${guid}`;
  const identifier = params.chatIdentifier?.trim();
  if (identifier) return `chat_identifier:${identifier}`;
  return "";
}
