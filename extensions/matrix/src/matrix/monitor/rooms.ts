import {
  buildChannelKeyCandidates,
  resolveChannelEntryMatchWithFallback,
} from "openclaw/plugin-sdk";
import type { MatrixRoomConfig } from "../../types.js";

export type MatrixRoomConfigResolved = {
  allowed: boolean;
  allowlistConfigured: boolean;
  config?: MatrixRoomConfig;
  matchKey?: string;
  matchSource?: "direct" | "wildcard";
};

const normalizeRoomKey = (key: string) => key.toLowerCase();

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
  const match = resolveChannelEntryMatchWithFallback({
    entries: rooms,
    keys: candidates,
    wildcardKey: "*",
    normalizeKey: normalizeRoomKey,
  });
  const resolved = match.entry;
  const allowed = resolved ? resolved.enabled !== false && resolved.allow !== false : false;
  const matchSource =
    match.matchSource === "direct" || match.matchSource === "wildcard"
      ? match.matchSource
      : undefined;
  return {
    allowed,
    allowlistConfigured,
    config: resolved,
    matchKey: match.matchKey,
    matchSource,
  };
}
