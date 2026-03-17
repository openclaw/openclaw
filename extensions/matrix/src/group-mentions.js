import { resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { resolveMatrixRoomConfig } from "./matrix/monitor/rooms.js";
function stripLeadingPrefixCaseInsensitive(value, prefix) {
  return value.toLowerCase().startsWith(prefix.toLowerCase()) ? value.slice(prefix.length).trim() : value;
}
function resolveMatrixRoomConfigForGroup(params) {
  const rawGroupId = params.groupId?.trim() ?? "";
  let roomId = rawGroupId;
  roomId = stripLeadingPrefixCaseInsensitive(roomId, "matrix:");
  roomId = stripLeadingPrefixCaseInsensitive(roomId, "channel:");
  roomId = stripLeadingPrefixCaseInsensitive(roomId, "room:");
  const groupChannel = params.groupChannel?.trim() ?? "";
  const aliases = groupChannel ? [groupChannel] : [];
  const cfg = params.cfg;
  const matrixConfig = resolveMatrixAccountConfig({ cfg, accountId: params.accountId });
  return resolveMatrixRoomConfig({
    rooms: matrixConfig.groups ?? matrixConfig.rooms,
    roomId,
    aliases,
    name: groupChannel || void 0
  }).config;
}
function resolveMatrixGroupRequireMention(params) {
  const resolved = resolveMatrixRoomConfigForGroup(params);
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
function resolveMatrixGroupToolPolicy(params) {
  const resolved = resolveMatrixRoomConfigForGroup(params);
  return resolved?.tools;
}
export {
  resolveMatrixGroupRequireMention,
  resolveMatrixGroupToolPolicy
};
