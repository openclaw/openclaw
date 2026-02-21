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

export function resolveMatrixRoomConfig(params: {
  rooms?: Record<string, MatrixRoomConfig>;
  roomId: string;
  aliases: string[];
  name?: string | null;
}): MatrixRoomConfigResolved {
  const rooms = params.rooms ?? {};
  const keys = Object.keys(rooms);
  const allowlistConfigured = keys.length > 0;
  // Normalize room IDs to lowercase for case-insensitive matching
  // Matrix room IDs should be treated case-insensitively
  const normalizedRoomId = params.roomId.toLowerCase();
  const normalizedAliases = params.aliases.map((alias) => alias.toLowerCase());
  const candidates = buildChannelKeyCandidates(
    normalizedRoomId,
    `room:${normalizedRoomId}`,
    ...normalizedAliases,
  );
  const {
    entry: matched,
    key: matchedKey,
    wildcardEntry,
    wildcardKey,
  } = resolveChannelEntryMatchWithFallback({
    entries: rooms,
    keys: candidates,
    wildcardKey: "*",
    normalizeKey: (k: string) => k.toLowerCase(),
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
