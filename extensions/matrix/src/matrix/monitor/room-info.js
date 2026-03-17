function createMatrixRoomInfoResolver(client) {
  const roomInfoCache = /* @__PURE__ */ new Map();
  const getRoomInfo = async (roomId) => {
    const cached = roomInfoCache.get(roomId);
    if (cached) {
      return cached;
    }
    let name;
    let canonicalAlias;
    let altAliases = [];
    try {
      const nameState = await client.getRoomStateEvent(roomId, "m.room.name", "").catch(() => null);
      name = nameState?.name;
    } catch {
    }
    try {
      const aliasState = await client.getRoomStateEvent(roomId, "m.room.canonical_alias", "").catch(() => null);
      canonicalAlias = aliasState?.alias;
      altAliases = aliasState?.alt_aliases ?? [];
    } catch {
    }
    const info = { name, canonicalAlias, altAliases };
    roomInfoCache.set(roomId, info);
    return info;
  };
  const getMemberDisplayName = async (roomId, userId) => {
    try {
      const memberState = await client.getRoomStateEvent(roomId, "m.room.member", userId).catch(() => null);
      return memberState?.displayname ?? userId;
    } catch {
      return userId;
    }
  };
  return {
    getRoomInfo,
    getMemberDisplayName
  };
}
export {
  createMatrixRoomInfoResolver
};
