import type { MatrixEvent } from "../types.js";
import { matrixFetch } from "./http.js";

// ── m.direct Account Data Cache ────────────────────────────────────────
// Caches the set of room IDs that are marked as DMs via m.direct account data.
// This is the authoritative DM indicator per the Matrix spec, falling back to
// member-count heuristic only when m.direct data is unavailable.

// SINGLETON: multi-account requires refactoring this to per-account state
let mDirectRoomIds: Set<string> | null = null;
let mDirectUserId: string | null = null;
let mDirectFetchedAt = 0;
const M_DIRECT_TTL_MS = 5 * 60 * 1000; // Re-fetch every 5 min

/**
 * Initialize m.direct cache with the account's user ID.
 * Must be called before isDmRoom will use m.direct data.
 */
export function initMDirectCache(userId: string): void {
  mDirectUserId = userId;
  mDirectRoomIds = null;
  mDirectFetchedAt = 0;
}

/**
 * Invalidate m.direct cache — call when account data changes are detected in sync.
 */
export function invalidateMDirectCache(): void {
  mDirectRoomIds = null;
  mDirectFetchedAt = 0;
}

/**
 * Fetch m.direct account data and populate the cache.
 * Returns the set of DM room IDs, or null if fetch fails.
 */
async function fetchMDirectRoomIds(): Promise<Set<string> | null> {
  if (!mDirectUserId) return null;

  // Use cached data if fresh enough
  if (mDirectRoomIds !== null && Date.now() - mDirectFetchedAt < M_DIRECT_TTL_MS) {
    return mDirectRoomIds;
  }

  try {
    const directData = await matrixFetch<Record<string, string[]>>(
      "GET",
      `/_matrix/client/v3/user/${encodeURIComponent(mDirectUserId)}/account_data/m.direct`,
    );

    const roomIds = new Set<string>();
    for (const rooms of Object.values(directData ?? {})) {
      if (Array.isArray(rooms)) {
        for (const roomId of rooms) {
          if (typeof roomId === "string") roomIds.add(roomId);
        }
      }
    }
    mDirectRoomIds = roomIds;
    mDirectFetchedAt = Date.now();
    return roomIds;
  } catch {
    // m.direct may not exist yet — return null to signal fallback
    return null;
  }
}

/**
 * In-memory room state tracker.
 *
 * Tracks:
 * - Encryption state per room (write-once: once true, never false per spec §11.12)
 * - Room type (dm vs group based on member count)
 * - Room display names
 * - Room membership
 */

// SINGLETON: multi-account requires refactoring all caches below to per-account state

// Encryption state — write-once per spec
const encryptionCache = new Map<string, boolean>();

// Encryption config — stores rotation parameters from m.room.encryption
interface RoomEncryptionConfig {
  algorithm: string;
  rotationPeriodMs: number;
  rotationPeriodMsgs: number;
}
const encryptionConfigCache = new Map<string, RoomEncryptionConfig>();

// Room type tracking
const roomTypeCache = new Map<string, "dm" | "group">();

// Room display names
const roomNameCache = new Map<string, string>();

// Room members: roomId → Set of userIds
const roomMembersCache = new Map<string, Set<string>>();

// Display names: roomId → (userId → displayName)
const displayNameCache = new Map<string, Map<string, string>>();
const DISPLAY_NAME_MAX_PER_ROOM = 1000;

/**
 * Check if a room has encryption enabled.
 */
export function isRoomEncrypted(roomId: string): boolean {
  return encryptionCache.get(roomId) === true;
}

/**
 * Mark a room as encrypted (write-once).
 */
export function setRoomEncrypted(roomId: string): void {
  encryptionCache.set(roomId, true);
}

/**
 * Get the encryption config for a room (algorithm, rotation parameters).
 */
export function getRoomEncryptionConfig(roomId: string): RoomEncryptionConfig | undefined {
  return encryptionConfigCache.get(roomId);
}

/**
 * Check if a room is a DM.
 *
 * Uses m.direct account data as the authoritative source when available,
 * falling back to the member-count heuristic (<=2 members) only when
 * m.direct data hasn't been fetched yet.
 */
export function isDmRoom(roomId: string): boolean {
  // Check m.direct cache first (synchronous — populated async)
  if (mDirectRoomIds !== null) {
    return mDirectRoomIds.has(roomId);
  }
  // Fallback: member-count heuristic
  return roomTypeCache.get(roomId) === "dm";
}

/**
 * Async version of isDmRoom that fetches m.direct data if not cached.
 * Preferred over isDmRoom() when an async context is available.
 */
export async function isDmRoomAsync(roomId: string): Promise<boolean> {
  const directRooms = await fetchMDirectRoomIds();
  if (directRooms !== null) {
    return directRooms.has(roomId);
  }
  // Fallback: member-count heuristic
  return roomTypeCache.get(roomId) === "dm";
}

/**
 * Get room display name.
 */
export function getRoomName(roomId: string): string | undefined {
  return roomNameCache.get(roomId);
}

/**
 * Get room members.
 */
export function getRoomMembers(roomId: string): Set<string> {
  return roomMembersCache.get(roomId) ?? new Set();
}

/**
 * Process state events from a sync response for a room.
 */
export function processStateEvents(roomId: string, events: MatrixEvent[]): void {
  for (const event of events) {
    switch (event.type) {
      case "m.room.encryption":
        // Write-once: once encrypted, always encrypted
        setRoomEncrypted(roomId);
        // Store/update rotation parameters (these CAN be updated by later events)
        {
          const content = event.content ?? {};
          encryptionConfigCache.set(roomId, {
            algorithm: (content.algorithm as string) ?? "m.megolm.v1.aes-sha2",
            rotationPeriodMs: (content.rotation_period as number) ?? 604_800_000, // 7 days
            rotationPeriodMsgs: (content.rotation_period_msgs as number) ?? 100,
          });
        }
        break;

      case "m.room.name":
        if (typeof event.content?.name === "string") {
          roomNameCache.set(roomId, event.content.name);
        }
        break;

      case "m.room.member": {
        const userId = event.state_key;
        if (!userId) break;

        let members = roomMembersCache.get(roomId);
        if (!members) {
          members = new Set();
          roomMembersCache.set(roomId, members);
        }

        const membership = event.content?.membership;
        if (membership === "join") {
          members.add(userId);
          // Cache display name from state event
          const dn = event.content?.displayname;
          if (typeof dn === "string" && dn) {
            let roomDn = displayNameCache.get(roomId);
            if (!roomDn) {
              roomDn = new Map();
              displayNameCache.set(roomId, roomDn);
            }
            if (roomDn.size < DISPLAY_NAME_MAX_PER_ROOM) {
              roomDn.set(userId, dn);
            }
          }
        } else if (membership === "leave" || membership === "ban") {
          members.delete(userId);
        }

        // Update room type based on member count
        // DM = exactly 2 members (or 1 if other left)
        roomTypeCache.set(roomId, members.size <= 2 ? "dm" : "group");
        break;
      }
    }
  }
}

/**
 * Get display name for a user in a room.
 * Cache → profile API → raw user ID fallback.
 */
export async function getMemberDisplayName(roomId: string, userId: string): Promise<string> {
  // Check room-level cache first
  const roomDn = displayNameCache.get(roomId);
  if (roomDn?.has(userId)) return roomDn.get(userId)!;

  // Fetch profile from homeserver
  try {
    const profile = await matrixFetch<{ displayname?: string }>(
      "GET",
      `/_matrix/client/v3/profile/${encodeURIComponent(userId)}`,
    );
    if (profile.displayname) {
      // Cache for future use
      let cache = displayNameCache.get(roomId);
      if (!cache) {
        cache = new Map();
        displayNameCache.set(roomId, cache);
      }
      if (cache.size < DISPLAY_NAME_MAX_PER_ROOM) {
        cache.set(userId, profile.displayname);
      }
      return profile.displayname;
    }
  } catch {
    // Profile fetch failed — use raw ID
  }
  return userId;
}

/**
 * Clean up state for a room we've left.
 *
 * NOTE: encryptionCache is NOT cleared — write-once per spec §11.12.
 * If we rejoin the room before re-receiving m.room.encryption state,
 * we must still know it's encrypted to avoid sending plaintext.
 */
export function cleanupRoom(roomId: string): void {
  // encryptionCache + encryptionConfigCache intentionally preserved (write-once)
  roomTypeCache.delete(roomId);
  roomNameCache.delete(roomId);
  roomMembersCache.delete(roomId);
  displayNameCache.delete(roomId);
}

/**
 * Get all tracked room IDs.
 */
export function getTrackedRoomIds(): string[] {
  return [...new Set([...encryptionCache.keys(), ...roomTypeCache.keys()])];
}
