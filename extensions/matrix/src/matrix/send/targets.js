import { EventType } from "./types.js";
function normalizeTarget(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Matrix target is required (room:<id> or #alias)");
  }
  return trimmed;
}
function normalizeThreadId(raw) {
  if (raw === void 0 || raw === null) {
    return null;
  }
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : null;
}
const MAX_DIRECT_ROOM_CACHE_SIZE = 1024;
const directRoomCache = /* @__PURE__ */ new Map();
function setDirectRoomCached(key, value) {
  directRoomCache.set(key, value);
  if (directRoomCache.size > MAX_DIRECT_ROOM_CACHE_SIZE) {
    const oldest = directRoomCache.keys().next().value;
    if (oldest !== void 0) {
      directRoomCache.delete(oldest);
    }
  }
}
async function persistDirectRoom(client, userId, roomId) {
  let directContent = null;
  try {
    directContent = await client.getAccountData(EventType.Direct);
  } catch {
  }
  const existing = directContent && !Array.isArray(directContent) ? directContent : {};
  const current = Array.isArray(existing[userId]) ? existing[userId] : [];
  if (current[0] === roomId) {
    return;
  }
  const next = [roomId, ...current.filter((id) => id !== roomId)];
  try {
    await client.setAccountData(EventType.Direct, {
      ...existing,
      [userId]: next
    });
  } catch {
  }
}
async function resolveDirectRoomId(client, userId) {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);
  }
  const cached = directRoomCache.get(trimmed);
  if (cached) {
    return cached;
  }
  try {
    const directContent = await client.getAccountData(EventType.Direct);
    const list = Array.isArray(directContent?.[trimmed]) ? directContent[trimmed] : [];
    if (list && list.length > 0) {
      setDirectRoomCached(trimmed, list[0]);
      return list[0];
    }
  } catch {
  }
  let fallbackRoom = null;
  try {
    const rooms = await client.getJoinedRooms();
    for (const roomId of rooms) {
      let members;
      try {
        members = await client.getJoinedRoomMembers(roomId);
      } catch {
        continue;
      }
      if (!members.includes(trimmed)) {
        continue;
      }
      if (members.length === 2) {
        setDirectRoomCached(trimmed, roomId);
        await persistDirectRoom(client, trimmed, roomId);
        return roomId;
      }
      if (!fallbackRoom) {
        fallbackRoom = roomId;
      }
    }
  } catch {
  }
  if (fallbackRoom) {
    setDirectRoomCached(trimmed, fallbackRoom);
    await persistDirectRoom(client, trimmed, fallbackRoom);
    return fallbackRoom;
  }
  throw new Error(`No direct room found for ${trimmed} (m.direct missing)`);
}
async function resolveMatrixRoomId(client, raw) {
  const target = normalizeTarget(raw);
  const lowered = target.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    return await resolveMatrixRoomId(client, target.slice("matrix:".length));
  }
  if (lowered.startsWith("room:")) {
    return await resolveMatrixRoomId(client, target.slice("room:".length));
  }
  if (lowered.startsWith("channel:")) {
    return await resolveMatrixRoomId(client, target.slice("channel:".length));
  }
  if (lowered.startsWith("user:")) {
    return await resolveDirectRoomId(client, target.slice("user:".length));
  }
  if (target.startsWith("@")) {
    return await resolveDirectRoomId(client, target);
  }
  if (target.startsWith("#")) {
    const resolved = await client.resolveRoom(target);
    if (!resolved) {
      throw new Error(`Matrix alias ${target} could not be resolved`);
    }
    return resolved;
  }
  return target;
}
export {
  normalizeThreadId,
  resolveMatrixRoomId
};
