import { matrixFetch } from "./http.js";

/**
 * Resolve a Matrix target (user, alias, or room ID) to a room ID.
 *
 * Handles:
 * - !roomId:domain → pass through
 * - @user:domain → look up DM room via m.direct account data, fallback to joined rooms scan
 * - #alias:domain → resolve via directory API
 * - Prefixed: matrix:, room:, channel:, user: stripped before resolution
 */
export async function resolveMatrixTarget(raw: string, userId: string): Promise<string> {
  let target = raw.trim();
  if (!target) throw new Error("Matrix target is required");

  // Strip prefixes
  if (target.toLowerCase().startsWith("matrix:")) {
    target = target.slice("matrix:".length).trim();
  }
  target = target.replace(/^(room|channel|user):/i, "").trim();

  if (target.startsWith("!")) {
    return target; // Already a room ID
  }

  if (target.startsWith("@")) {
    return resolveDirectRoomId(target, userId);
  }

  if (target.startsWith("#")) {
    return resolveRoomAlias(target);
  }

  // Assume room ID if nothing else matches
  return target;
}

// ── DM Room Resolution ──────────────────────────────────────────────

// SINGLETON: multi-account requires refactoring this to per-account state
const directRoomCache = new Map<string, string>();

async function resolveDirectRoomId(targetUserId: string, ownUserId: string): Promise<string> {
  const cached = directRoomCache.get(targetUserId);
  if (cached) return cached;

  // 1. Check m.direct account data
  try {
    const directData = await matrixFetch<Record<string, string[]>>(
      "GET",
      `/_matrix/client/v3/user/${encodeURIComponent(ownUserId)}/account_data/m.direct`,
    );
    const rooms = directData?.[targetUserId];
    if (Array.isArray(rooms) && rooms.length > 0) {
      directRoomCache.set(targetUserId, rooms[0]);
      return rooms[0];
    }
  } catch {
    // m.direct may not exist yet
  }

  // 2. Fallback: scan joined rooms for a 1:1 with the target user
  try {
    const { joined_rooms } = await matrixFetch<{ joined_rooms: string[] }>(
      "GET",
      "/_matrix/client/v3/joined_rooms",
    );

    let fallback: string | null = null;
    const scanLimit = Math.min((joined_rooms ?? []).length, 20);
    for (let i = 0; i < scanLimit; i++) {
      const roomId = joined_rooms[i];
      try {
        const { joined } = await matrixFetch<{
          joined: Record<string, unknown>;
        }>("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`);
        const members = Object.keys(joined ?? {});
        if (!members.includes(targetUserId)) continue;
        if (members.length === 2) {
          directRoomCache.set(targetUserId, roomId);
          return roomId;
        }
        if (!fallback) fallback = roomId;
      } catch {
        continue;
      }
    }
    if (fallback) {
      directRoomCache.set(targetUserId, fallback);
      return fallback;
    }
  } catch {
    // joined_rooms API failed
  }

  throw new Error(
    `No DM room found for ${targetUserId}. Create a DM room first or use a room ID (!...)`,
  );
}

// ── Room Alias Resolution ───────────────────────────────────────────

async function resolveRoomAlias(alias: string): Promise<string> {
  const response = await matrixFetch<{ room_id: string }>(
    "GET",
    `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
  );
  if (!response.room_id) {
    throw new Error(`Matrix alias ${alias} could not be resolved`);
  }
  return response.room_id;
}
