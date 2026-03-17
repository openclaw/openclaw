const DM_CACHE_TTL_MS = 3e4;
function isMatrixNotFoundError(err) {
  if (typeof err !== "object" || err === null) return false;
  const e = err;
  return e.errcode === "M_NOT_FOUND" || e.statusCode === 404;
}
function createDirectRoomTracker(client, opts = {}) {
  const log = opts.log ?? (() => {
  });
  const includeMemberCountInLogs = opts.includeMemberCountInLogs === true;
  let lastDmUpdateMs = 0;
  let cachedSelfUserId = null;
  const memberCountCache = /* @__PURE__ */ new Map();
  const ensureSelfUserId = async () => {
    if (cachedSelfUserId) {
      return cachedSelfUserId;
    }
    try {
      cachedSelfUserId = await client.getUserId();
    } catch {
      cachedSelfUserId = null;
    }
    return cachedSelfUserId;
  };
  const refreshDmCache = async () => {
    const now = Date.now();
    if (now - lastDmUpdateMs < DM_CACHE_TTL_MS) {
      return;
    }
    lastDmUpdateMs = now;
    try {
      await client.dms.update();
    } catch (err) {
      log(`matrix: dm cache refresh failed (${String(err)})`);
    }
  };
  const resolveMemberCount = async (roomId) => {
    const cached = memberCountCache.get(roomId);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.count;
    }
    try {
      const members = await client.getJoinedRoomMembers(roomId);
      const count = members.length;
      memberCountCache.set(roomId, { count, ts: now });
      return count;
    } catch (err) {
      log(`matrix: dm member count failed room=${roomId} (${String(err)})`);
      return null;
    }
  };
  const hasDirectFlag = async (roomId, userId) => {
    const target = userId?.trim();
    if (!target) {
      return false;
    }
    try {
      const state = await client.getRoomStateEvent(roomId, "m.room.member", target);
      return state?.is_direct === true;
    } catch {
      return false;
    }
  };
  return {
    isDirectMessage: async (params) => {
      const { roomId, senderId } = params;
      await refreshDmCache();
      if (client.dms.isDm(roomId)) {
        log(`matrix: dm detected via m.direct room=${roomId}`);
        return true;
      }
      const selfUserId = params.selfUserId ?? await ensureSelfUserId();
      const directViaState = await hasDirectFlag(roomId, senderId) || await hasDirectFlag(roomId, selfUserId ?? "");
      if (directViaState) {
        log(`matrix: dm detected via member state room=${roomId}`);
        return true;
      }
      const memberCount = await resolveMemberCount(roomId);
      if (memberCount === 2) {
        try {
          const nameState = await client.getRoomStateEvent(roomId, "m.room.name", "");
          if (!nameState?.name?.trim()) {
            log(`matrix: dm detected via fallback (2 members, no room name) room=${roomId}`);
            return true;
          }
        } catch (err) {
          if (isMatrixNotFoundError(err)) {
            log(`matrix: dm detected via fallback (2 members, no room name) room=${roomId}`);
            return true;
          }
          log(
            `matrix: dm fallback skipped (room name check failed: ${String(err)}) room=${roomId}`
          );
        }
      }
      if (!includeMemberCountInLogs) {
        log(`matrix: dm check room=${roomId} result=group`);
        return false;
      }
      log(`matrix: dm check room=${roomId} result=group members=${memberCount ?? "unknown"}`);
      return false;
    }
  };
}
export {
  createDirectRoomTracker
};
