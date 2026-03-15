import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

export type MatrixRoomInfo = {
  name?: string;
  canonicalAlias?: string;
  altAliases: string[];
};

type CachedRoomInfo = MatrixRoomInfo & { cachedAt: number };

const ROOM_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const ROOM_INFO_CACHE_MAX_SIZE = 500;

export function createMatrixRoomInfoResolver(client: MatrixClient) {
  const roomInfoCache = new Map<string, CachedRoomInfo>();

  const getRoomInfo = async (roomId: string): Promise<MatrixRoomInfo> => {
    const cached = roomInfoCache.get(roomId);
    if (cached && Date.now() - cached.cachedAt < ROOM_INFO_CACHE_TTL_MS) {
      return cached;
    }
    let name: string | undefined;
    let canonicalAlias: string | undefined;
    let altAliases: string[] = [];
    try {
      const nameState = await client.getRoomStateEvent(roomId, "m.room.name", "").catch(() => null);
      name = nameState?.name;
    } catch {
      // ignore
    }
    try {
      const aliasState = await client
        .getRoomStateEvent(roomId, "m.room.canonical_alias", "")
        .catch(() => null);
      canonicalAlias = aliasState?.alias;
      altAliases = aliasState?.alt_aliases ?? [];
    } catch {
      // ignore
    }
    const info: CachedRoomInfo = { name, canonicalAlias, altAliases, cachedAt: Date.now() };
    if (!roomInfoCache.has(roomId) && roomInfoCache.size >= ROOM_INFO_CACHE_MAX_SIZE) {
      const firstKey = roomInfoCache.keys().next().value;
      if (firstKey !== undefined) {
        roomInfoCache.delete(firstKey);
      }
    }
    roomInfoCache.set(roomId, info);
    return info;
  };

  const getMemberDisplayName = async (roomId: string, userId: string): Promise<string> => {
    try {
      const memberState = await client
        .getRoomStateEvent(roomId, "m.room.member", userId)
        .catch(() => null);
      return memberState?.displayname ?? userId;
    } catch {
      return userId;
    }
  };

  return {
    getRoomInfo,
    getMemberDisplayName,
  };
}
