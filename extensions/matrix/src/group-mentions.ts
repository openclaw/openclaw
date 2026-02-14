import type { ChannelGroupContext, GroupToolPolicyConfig } from "openclaw/plugin-sdk";
import type { CoreConfig } from "./types.js";
import { resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { resolveMatrixRoomConfig } from "./matrix/monitor/rooms.js";

export function resolveMatrixGroupRequireMention(params: ChannelGroupContext): boolean {
  const rawGroupId = params.groupId?.trim() ?? "";
  let roomId = rawGroupId;
  const lower = roomId.toLowerCase();
  if (lower.startsWith("matrix:")) {
    roomId = roomId.slice("matrix:".length).trim();
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
  const matrixConfig = resolveMatrixAccountConfig({ cfg, accountId: params.accountId });
  const resolved = resolveMatrixRoomConfig({
    rooms: matrixConfig.groups ?? matrixConfig.rooms,
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

export function resolveMatrixGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const rawGroupId = params.groupId?.trim() ?? "";
  let roomId = rawGroupId;
  const lower = roomId.toLowerCase();
  if (lower.startsWith("matrix:")) {
    roomId = roomId.slice("matrix:".length).trim();
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
  const matrixConfig = resolveMatrixAccountConfig({ cfg, accountId: params.accountId });
  const resolved = resolveMatrixRoomConfig({
    rooms: matrixConfig.groups ?? matrixConfig.rooms,
    roomId,
    aliases,
    name: groupChannel || undefined,
  }).config;
  return resolved?.tools;
}
