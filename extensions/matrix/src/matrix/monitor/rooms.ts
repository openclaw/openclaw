import type { MatrixConfig, MatrixRoomConfig } from "../../types.js";
import {
  buildChannelKeyCandidates,
  resolveChannelEntryMatch,
} from "../../../../../src/channels/plugins/channel-config.js";

export type MatrixRoomConfigResolved = {
  allowed: boolean;
  allowlistConfigured: boolean;
  config?: MatrixRoomConfig;
};

export function resolveMatrixRoomConfig(params: {
  rooms?: MatrixConfig["rooms"];
  roomId: string;
  aliases: string[];
  name?: string | null;
}): MatrixRoomConfigResolved {
  const rooms = params.rooms ?? {};
  const keys = Object.keys(rooms);
  const allowlistConfigured = keys.length > 0;
  const candidates = buildChannelKeyCandidates(
    params.roomId,
    `room:${params.roomId}`,
    ...params.aliases,
    params.name ?? "",
  );
  const { entry: matched, wildcardEntry } = resolveChannelEntryMatch({
    entries: rooms,
    keys: candidates,
    wildcardKey: "*",
  });
  const resolved = matched ?? wildcardEntry;
  const allowed = resolved ? resolved.enabled !== false && resolved.allow !== false : false;
  return { allowed, allowlistConfigured, config: resolved };
}
