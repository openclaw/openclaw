import { isStrictDirectRoom } from "../direct-room.js";
import type { MatrixClient } from "../sdk.js";
import { isMatrixQualifiedUserId, normalizeMatrixResolvableTarget } from "../target-ids.js";
import { EventType, type MatrixDirectAccountData } from "./types.js";

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Matrix target is required (room:<id> or #alias)");
  }
  return trimmed;
}

export function normalizeThreadId(raw?: string | number | null): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : null;
}

// Size-capped to prevent unbounded growth (#4948)
const MAX_DIRECT_ROOM_CACHE_SIZE = 1024;
const directRoomCacheByClient = new WeakMap<MatrixClient, Map<string, string>>();

function resolveDirectRoomCache(client: MatrixClient): Map<string, string> {
  const existing = directRoomCacheByClient.get(client);
  if (existing) {
    return existing;
  }
  const created = new Map<string, string>();
  directRoomCacheByClient.set(client, created);
  return created;
}

function setDirectRoomCached(client: MatrixClient, key: string, value: string): void {
  const directRoomCache = resolveDirectRoomCache(client);
  directRoomCache.set(key, value);
  if (directRoomCache.size > MAX_DIRECT_ROOM_CACHE_SIZE) {
    const oldest = directRoomCache.keys().next().value;
    if (oldest !== undefined) {
      directRoomCache.delete(oldest);
    }
  }
}

async function persistDirectRoom(
  client: MatrixClient,
  userId: string,
  roomId: string,
): Promise<void> {
  let directContent: MatrixDirectAccountData | undefined;
  try {
    directContent = (await client.getAccountData(EventType.Direct)) as
      | MatrixDirectAccountData
      | undefined;
  } catch {
    // Ignore fetch errors and fall back to an empty map.
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
      [userId]: next,
    });
  } catch {
    // Ignore persistence errors.
  }
}

async function resolveDirectRoomId(client: MatrixClient, userId: string): Promise<string> {
  const trimmed = userId.trim();
  if (!isMatrixQualifiedUserId(trimmed)) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);
  }
  const selfUserId = (await client.getUserId().catch(() => null))?.trim() || null;

  const directRoomCache = resolveDirectRoomCache(client);
  const cached = directRoomCache.get(trimmed);
  if (
    cached &&
    (await isStrictDirectRoom({ client, roomId: cached, remoteUserId: trimmed, selfUserId }))
  ) {
    return cached;
  }
  if (cached) {
    directRoomCache.delete(trimmed);
  }

  // 1) Fast path: use account data (m.direct) for *this* logged-in user (the bot).
  try {
    const directContent = (await client.getAccountData(EventType.Direct)) as Record<
      string,
      string[] | undefined
    >;
    const list = Array.isArray(directContent?.[trimmed]) ? directContent[trimmed] : [];
    for (const roomId of list) {
      if (await isStrictDirectRoom({ client, roomId, remoteUserId: trimmed, selfUserId })) {
        setDirectRoomCached(client, trimmed, roomId);
        return roomId;
      }
    }
  } catch {
    // Ignore and fall back.
  }

  // 2) Fallback: look for an existing joined room that is actually a 1:1 with the user.
  // Many clients only maintain m.direct for *their own* account data, so relying on it is brittle.
  try {
    const rooms = await client.getJoinedRooms();
    for (const roomId of rooms) {
      if (await isStrictDirectRoom({ client, roomId, remoteUserId: trimmed, selfUserId })) {
        setDirectRoomCached(client, trimmed, roomId);
        await persistDirectRoom(client, trimmed, roomId);
        return roomId;
      }
    }
  } catch {
    // Ignore and fall back.
  }

  throw new Error(`No direct room found for ${trimmed} (m.direct missing)`);
}

export async function resolveMatrixRoomId(client: MatrixClient, raw: string): Promise<string> {
  const target = normalizeMatrixResolvableTarget(normalizeTarget(raw));
  const lowered = target.toLowerCase();
  if (lowered.startsWith("user:")) {
    return await resolveDirectRoomId(client, target.slice("user:".length));
  }
  if (isMatrixQualifiedUserId(target)) {
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
