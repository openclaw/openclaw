import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

type DirectMessageCheck = {
  roomId: string;
  senderId?: string;
  selfUserId?: string;
};

type DirectRoomTrackerOptions = {
  log?: (message: string) => void;
  includeMemberCountInLogs?: boolean;
};

const DM_CACHE_TTL_MS = 30_000;

/**
 * Check if an error is a Matrix M_NOT_FOUND response (missing state event).
 * The bot-sdk throws MatrixError with errcode/statusCode on the error object.
 */
function isMatrixNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { errcode?: string; statusCode?: number };
  return e.errcode === "M_NOT_FOUND" || e.statusCode === 404;
}

export function createDirectRoomTracker(client: MatrixClient, opts: DirectRoomTrackerOptions = {}) {
  const log = opts.log ?? (() => {});
  const includeMemberCountInLogs = opts.includeMemberCountInLogs === true;
  let lastDmUpdateMs = 0;
  let cachedSelfUserId: string | null = null;
  const memberCountCache = new Map<string, { count: number; ts: number }>();

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
    try {
      await client.dms.update();
    } catch (err) {
      log(`matrix: dm cache refresh failed (${String(err)})`);
    }
  };

  const resolveMemberCount = async (roomId: string): Promise<number | null> => {
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

  const hasDirectFlag = async (roomId: string, userId?: string): Promise<boolean> => {
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
    isDirectMessage: async (params: DirectMessageCheck): Promise<boolean> => {
      const { roomId, senderId } = params;
      await refreshDmCache();

      // Check m.direct account data (most authoritative)
      if (client.dms.isDm(roomId)) {
        log(`matrix: dm detected via m.direct room=${roomId}`);
        return true;
      }

      const selfUserId = params.selfUserId ?? (await ensureSelfUserId());
      const directViaState =
        (await hasDirectFlag(roomId, senderId)) || (await hasDirectFlag(roomId, selfUserId ?? ""));
      if (directViaState) {
        log(`matrix: dm detected via member state room=${roomId}`);
        return true;
      }

      // Conservative fallback: 2-member rooms without an explicit room name are likely
      // DMs with broken m.direct / is_direct flags. This has been observed on Continuwuity
      // where m.direct pointed to the wrong room and is_direct was never set on the invite.
      // Unlike the removed heuristic, this requires two signals (member count + no name)
      // to avoid false positives on named 2-person group rooms.
      //
      // Performance: member count is cached (resolveMemberCount). The room name state
      // check is not cached but only runs for the subset of 2-member rooms that reach
      // this fallback path (no m.direct, no is_direct). In typical deployments this is
      // a small minority of rooms.
      //
      // Note: there is a narrow race where a room name is being set concurrently with
      // this check. The consequence is a one-time misclassification that self-corrects
      // on the next message (once the state event is synced). This is acceptable given
      // the alternative of an additional API call on every message.
      const memberCount = await resolveMemberCount(roomId);
      if (memberCount === 2) {
        try {
          const nameState = await client.getRoomStateEvent(roomId, "m.room.name", "");
          if (!nameState?.name?.trim()) {
            log(`matrix: dm detected via fallback (2 members, no room name) room=${roomId}`);
            return true;
          }
        } catch (err: unknown) {
          // Missing state events (M_NOT_FOUND) are expected for unnamed rooms and
          // strongly indicate a DM. Any other error (network, auth) is ambiguous,
          // so we fall through to classify as group rather than guess.
          if (isMatrixNotFoundError(err)) {
            log(`matrix: dm detected via fallback (2 members, no room name) room=${roomId}`);
            return true;
          }
          log(
            `matrix: dm fallback skipped (room name check failed: ${String(err)}) room=${roomId}`,
          );
        }
      }

      if (!includeMemberCountInLogs) {
        log(`matrix: dm check room=${roomId} result=group`);
        return false;
      }
      log(`matrix: dm check room=${roomId} result=group members=${memberCount ?? "unknown"}`);
      return false;
    },
  };
}
