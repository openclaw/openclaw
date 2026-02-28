import type { ChannelGroupContext, GroupToolPolicyConfig } from "openclaw/plugin-sdk";
import { resolveMatrixRoomConfig } from "./dejoy/monitor/rooms.js";
import type { CoreConfig } from "./types.js";

export function resolveDeJoyGroupRequireMention(params: ChannelGroupContext): boolean {
  const rawGroupId = params.groupId?.trim() ?? "";
  let roomId = rawGroupId;
  const lower = roomId.toLowerCase();
  if (lower.startsWith("dejoy:")) {
    roomId = roomId.slice("dejoy:".length).trim();
  }
  if (roomId.toLowerCase().startsWith("channel:")) {
    roomId = roomId.slice("channel:".length).trim();
  }
  if (roomId.toLowerCase().startsWith("room:")) {
    roomId = roomId.slice("room:".length).trim();
  }
  const groupChannel = params.groupChannel?.trim() ?? "";
  const aliases = groupChannel ? [groupChannel] : [];
  const cfg = params.cfg as CoreConfig;
  const resolved = resolveMatrixRoomConfig({
    rooms: cfg.channels?.dejoy?.groups ?? cfg.channels?.dejoy?.rooms,
    roomId,
    aliases,
    name: groupChannel || undefined,
  }).config;
  if (resolved) {
    if (resolved.autoReply === true) {
      return false;
    }
    if (resolved.autoReply === false) {
      return true;
    }
    if (typeof resolved.requireMention === "boolean") {
      return resolved.requireMention;
    }
  }
  return true;
}

export function resolveDeJoyGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const rawGroupId = params.groupId?.trim() ?? "";
  let roomId = rawGroupId;
  const lower = roomId.toLowerCase();
  if (lower.startsWith("dejoy:")) {
    roomId = roomId.slice("dejoy:".length).trim();
  }
  if (roomId.toLowerCase().startsWith("channel:")) {
    roomId = roomId.slice("channel:".length).trim();
  }
  if (roomId.toLowerCase().startsWith("room:")) {
    roomId = roomId.slice("room:".length).trim();
  }
  const groupChannel = params.groupChannel?.trim() ?? "";
  const aliases = groupChannel ? [groupChannel] : [];
  const cfg = params.cfg as CoreConfig;
  const resolved = resolveMatrixRoomConfig({
    rooms: cfg.channels?.dejoy?.groups ?? cfg.channels?.dejoy?.rooms,
    roomId,
    aliases,
    name: groupChannel || undefined,
  }).config;
  return resolved?.tools;
}
