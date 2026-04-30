import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

export type VesicleTarget =
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "handle"; to: string };

const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

function stripVesiclePrefix(value: string): string {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return "";
  }
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("vesicle:")) {
    return trimmed;
  }
  return trimmed.slice("vesicle:".length).trim();
}

function parseRawChatGuid(value: string): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(";");
  if (parts.length !== 3) {
    return null;
  }
  const service = normalizeOptionalString(parts[0]);
  const separator = normalizeOptionalString(parts[1]);
  const identifier = normalizeOptionalString(parts[2]);
  if (!service || !identifier) {
    return null;
  }
  if (separator !== "+" && separator !== "-") {
    return null;
  }
  return `${service};${separator};${identifier}`;
}

export function extractHandleFromVesicleChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length === 3 && parts[1] === "-") {
    return normalizeOptionalString(parts[2]) ?? null;
  }
  return null;
}

export function parseVesicleTarget(raw: string): VesicleTarget {
  const trimmed = stripVesiclePrefix(raw);
  if (!trimmed) {
    throw new Error("Vesicle target is required");
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);

  for (const prefix of CHAT_GUID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (!value) {
        throw new Error("Vesicle chat_guid target is required");
      }
      return { kind: "chat_guid", chatGuid: value };
    }
  }

  if (lower.startsWith("group:")) {
    const value = stripPrefix(trimmed, "group:");
    if (!value) {
      throw new Error("Vesicle group target is required");
    }
    return { kind: "chat_guid", chatGuid: value };
  }

  const rawChatGuid = parseRawChatGuid(trimmed);
  if (rawChatGuid) {
    return { kind: "chat_guid", chatGuid: rawChatGuid };
  }

  return { kind: "handle", to: trimmed };
}

export function normalizeVesicleMessagingTarget(raw: string): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = parseVesicleTarget(trimmed);
    if (parsed.kind === "chat_guid") {
      return `chat_guid:${parsed.chatGuid}`;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

export function looksLikeVesicleExplicitTargetId(raw: string, normalized?: string): boolean {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) {
    return false;
  }
  const candidate = stripVesiclePrefix(trimmed);
  if (!candidate) {
    return false;
  }
  if (parseRawChatGuid(candidate)) {
    return true;
  }
  const lowered = normalizeLowercaseStringOrEmpty(candidate);
  if (CHAT_GUID_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return true;
  }
  if (lowered.startsWith("group:")) {
    return true;
  }
  const normalizedTrimmed = normalizeOptionalString(normalized);
  if (!normalizedTrimmed) {
    return false;
  }
  const normalizedLower = normalizeLowercaseStringOrEmpty(normalizedTrimmed);
  return CHAT_GUID_PREFIXES.some((prefix) => normalizedLower.startsWith(prefix));
}

export function inferVesicleTargetChatType(raw: string): "direct" | "group" | undefined {
  try {
    const parsed = parseVesicleTarget(raw);
    if (parsed.kind !== "chat_guid") {
      return undefined;
    }
    if (parsed.chatGuid.includes(";-;")) {
      return "direct";
    }
    return "group";
  } catch {
    return undefined;
  }
}

export function resolveVesicleOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const stripped = stripChannelTargetPrefix(params.target, "vesicle");
  if (!stripped) {
    return null;
  }
  const parsed = parseVesicleTarget(stripped);
  if (parsed.kind !== "chat_guid") {
    return null;
  }
  const isGroup = parsed.chatGuid.includes(";+;") || !parsed.chatGuid.includes(";-;");
  const peerId = isGroup
    ? parsed.chatGuid
    : (extractHandleFromVesicleChatGuid(parsed.chatGuid) ?? parsed.chatGuid);
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "vesicle",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `group:${peerId}` : `vesicle:${peerId}`,
    to: `vesicle:chat_guid:${parsed.chatGuid}`,
  });
}
