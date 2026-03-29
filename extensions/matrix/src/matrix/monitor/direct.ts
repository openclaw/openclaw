import {
  hasDirectMatrixMemberFlag,
  isStrictDirectMembership,
  readJoinedMatrixMembers,
} from "../direct-room.js";
import type { MatrixClient } from "../sdk.js";

type DirectMessageCheck = {
  roomId: string;
  senderId?: string;
  selfUserId?: string;
};

type DirectRoomTrackerOptions = {
  log?: (message: string) => void;
};

const DM_CACHE_TTL_MS = 30_000;
const MAX_TRACKED_DM_ROOMS = 1024;
const MAX_TRACKED_DM_MEMBER_FLAGS = 2048;

function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  if (map.size > MAX_TRACKED_DM_ROOMS) {
    const oldest = map.keys().next().value;
    if (typeof oldest === "string") {
      map.delete(oldest);
    }
  }
}

export function createDirectRoomTracker(client: MatrixClient, opts: DirectRoomTrackerOptions = {}) {
  const log = opts.log ?? (() => {});
  let lastDmUpdateMs = 0;
  // Once m.direct has seeded successfully, prefer the explicit cache over
  // re-enabling the broad 2-person fallback after a later transient failure.
  let hasSeededDmCache = false;
  let cachedSelfUserId: string | null = null;
  const joinedMembersCache = new Map<string, { members: string[]; ts: number }>();
  const directMemberFlagCache = new Map<string, { isDirect: boolean | null; ts: number }>();

  const ensureSelfUserId = async (): Promise<string | null> => {
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

  const refreshDmCache = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastDmUpdateMs < DM_CACHE_TTL_MS) {
      return;
    }
    lastDmUpdateMs = now;
    hasSeededDmCache = (await client.dms.update()) || hasSeededDmCache;
  };

  const resolveJoinedMembers = async (roomId: string): Promise<string[] | null> => {
    const cached = joinedMembersCache.get(roomId);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.members;
    }
    try {
      const normalized = await readJoinedMatrixMembers(client, roomId);
      if (!normalized) {
        throw new Error("membership unavailable");
      }
      rememberBounded(joinedMembersCache, roomId, { members: normalized, ts: now });
      return normalized;
    } catch (err) {
      log(`matrix: dm member lookup failed room=${roomId} (${String(err)})`);
      return null;
    }
  };

  const resolveDirectMemberFlag = async (
    roomId: string,
    userId?: string | null,
  ): Promise<boolean | null> => {
    const normalizedUserId = userId?.trim();
    if (!normalizedUserId) {
      return null;
    }
    const cacheKey = `${roomId}\n${normalizedUserId}`;
    const cached = directMemberFlagCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.isDirect;
    }
    const isDirect = await hasDirectMatrixMemberFlag(client, roomId, normalizedUserId);
    rememberBounded(directMemberFlagCache, cacheKey, { isDirect, ts: now });
    return isDirect;
  };

  return {
    invalidateRoom: (roomId: string): void => {
      joinedMembersCache.delete(roomId);
      for (const key of directMemberFlagCache.keys()) {
        if (key.startsWith(`${roomId}\n`)) {
          directMemberFlagCache.delete(key);
        }
      }
      lastDmUpdateMs = 0;
      log(`matrix: invalidated dm cache room=${roomId}`);
    },
    isDirectMessage: async (params: DirectMessageCheck): Promise<boolean> => {
      const { roomId, senderId } = params;
      const selfUserId = params.selfUserId ?? (await ensureSelfUserId());
      const joinedMembers = await resolveJoinedMembers(roomId);

      // Check is_direct flag first (authoritative Matrix protocol signal)
      const directViaSender = await resolveDirectMemberFlag(roomId, senderId);
      const directViaSelf = await resolveDirectMemberFlag(roomId, selfUserId);

      // Use is_direct flag if available from either user
      const directViaState: boolean | null =
        directViaSender !== null ? directViaSender : directViaSelf;

      const strictDirectMembership = isStrictDirectMembership({
        selfUserId,
        remoteUserId: senderId,
        joinedMembers,
        isDirectFlag: directViaState,
      });

      try {
        await refreshDmCache();
      } catch (err) {
        log(`matrix: dm cache refresh failed (${String(err)})`);
      }

      // Priority 1: m.direct cache (client standard)
      if (client.dms.isDm(roomId)) {
        if (strictDirectMembership) {
          log(`matrix: dm detected via m.direct room=${roomId}`);
          return true;
        }
        log(`matrix: ignoring stale m.direct classification room=${roomId}`);
      }

      // Priority 2: is_direct flag (Matrix protocol standard)
      if (directViaState === true && strictDirectMembership) {
        log(`matrix: dm detected via member state room=${roomId}`);
        return true;
      }

      // Priority 3: 2-member fallback (only before dm cache seed and no is_direct flag)
      if (strictDirectMembership && !hasSeededDmCache && directViaState === null) {
        log(`matrix: dm detected via exact 2-member fallback before dm cache seed room=${roomId}`);
        return true;
      }

      log(
        `matrix: dm check room=${roomId} result=group members=${joinedMembers?.length ?? "unknown"} is_direct=${directViaState}`,
      );
      return false;
    },
  };
}
