import { CommandLane, CONV_LANE_PREFIX } from "../../process/lanes.js";

export function resolveSessionLane(key: string) {
  const cleaned = key.trim() || CommandLane.Main;
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string) {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : CommandLane.Main;
}

export function resolveEmbeddedSessionLane(key: string) {
  return resolveSessionLane(key);
}

export function resolveConversationLane(params: {
  channel?: string;
  accountId?: string;
  peerId?: string;
}): string {
  const channel = (params.channel ?? "").trim().toLowerCase();
  const accountId = (params.accountId ?? "").trim().toLowerCase() || "default";
  const peerId = (params.peerId ?? "").trim().toLowerCase();
  if (!channel && !peerId) {
    return "";
  }
  return `${CONV_LANE_PREFIX}${channel || "unknown"}:${accountId}:${peerId || "unknown"}`;
}

export function parseConversationPartsFromSessionKey(sessionKey?: string): {
  channel: string;
  peerId: string;
} {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) {
    return { channel: "", peerId: "" };
  }
  const parts = raw.split(":");
  if (parts[0] !== "agent" || parts.length < 5) {
    return { channel: "", peerId: "" };
  }
  return { channel: parts[2] ?? "", peerId: parts[4] ?? "" };
}
