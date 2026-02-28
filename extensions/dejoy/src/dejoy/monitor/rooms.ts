import { buildChannelKeyCandidates, resolveChannelEntryMatch } from "openclaw/plugin-sdk";
import type { MatrixRoomConfig } from "../../types.js";

export type MatrixRoomConfigResolved = {
  allowed: boolean;
  allowlistConfigured: boolean;
  config?: MatrixRoomConfig;
  matchKey?: string;
  matchSource?: "direct" | "wildcard";
};

export function resolveMatrixRoomConfig(params: {
  rooms?: Record<string, MatrixRoomConfig>;
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
  );
  const {
    entry: matched,
    key: matchedKey,
    wildcardEntry,
    wildcardKey,
  } = resolveChannelEntryMatch({
    entries: rooms,
    keys: candidates,
    wildcardKey: "*",
  });
  const resolved = matched ?? wildcardEntry;
  const allowed = resolved ? resolved.enabled !== false && resolved.allow !== false : false;
  const matchKey = matchedKey ?? wildcardKey;
  const matchSource = matched ? "direct" : wildcardEntry ? "wildcard" : undefined;
  return {
    allowed,
    allowlistConfigured,
    config: resolved,
    matchKey,
    matchSource,
  };
}
