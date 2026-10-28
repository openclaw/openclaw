import { isMatrixNotFoundError } from "../errors.js";
import type { MatrixClient } from "../sdk.js";
import { setBoundedMap } from "./bounded-cache.js";

export type MatrixRoomInfo = {
  name?: string;
  canonicalAlias?: string;
  altAliases: string[];
  nameResolved: boolean;
  aliasesResolved: boolean;
};

const MAX_ROOM_INFO = 1024;
const MAX_MEMBER_DISPLAY_NAMES = 4096;

export function createMatrixRoomInfoResolver(client: MatrixClient) {
  const memberDisplayNameCache = new Map<string, string>();
  const currentRoomNameCache = new Map<string, { value: string | undefined; resolved: boolean }>();

  function createRoomStateResolver<T>(
    eventType: string,
    project: (state: Record<string, unknown> | undefined) => T,
    cache = new Map<string, { value: T; resolved: boolean }>(),
  ) {
    return async (roomId: string) => {
      const cached = cache.get(roomId);
      if (cached?.resolved) {
        return cached;
      }
      let state: Record<string, unknown> | undefined;
      let resolved: boolean;
      try {
        state = await client.getRoomStateEvent(roomId, eventType, "");
        resolved = true;
      } catch (err) {
        resolved = isMatrixNotFoundError(err);
      }
      const info = { value: project(state), resolved };
      if (resolved) {
        setBoundedMap(cache, roomId, info, MAX_ROOM_INFO);
      }
      return info;
    };
  }

  // The first name resolved for a room, kept until it is evicted or the monitor restarts.
  // DM promotion reads this one, so renames do not change which rooms can be promoted.
  const getRoomName = createRoomStateResolver("m.room.name", (state) =>
    typeof state?.name === "string" ? state.name : undefined,
  );
  const getCurrentRoomName = createRoomStateResolver(
    "m.room.name",
    (state) => (typeof state?.name === "string" ? state.name : undefined),
    currentRoomNameCache,
  );
  const getRoomAliases = createRoomStateResolver("m.room.canonical_alias", (state) => ({
    canonicalAlias: typeof state?.alias === "string" ? state.alias : undefined,
    altAliases: Array.isArray(state?.alt_aliases)
      ? state.alt_aliases.filter((entry): entry is string => typeof entry === "string")
      : [],
  }));

  /**
   * `name` is the first name resolved for the room. With `currentName`, a room renamed since
   * then (an observed m.room.name event) reports its current name instead.
   */
  const getRoomInfo = async (
    roomId: string,
    opts: { includeAliases?: boolean; currentName?: boolean } = {},
  ): Promise<MatrixRoomInfo> => {
    const firstName = await getRoomName(roomId);
    const { value: name, resolved: nameResolved } =
      opts.currentName && currentRoomNameCache.has(roomId)
        ? await getCurrentRoomName(roomId)
        : firstName;
    if (!opts.includeAliases) {
      return { name, altAliases: [], nameResolved, aliasesResolved: false };
    }
    const { value: aliases, resolved: aliasesResolved } = await getRoomAliases(roomId);
    return { name, nameResolved, ...aliases, aliasesResolved };
  };

  const getMemberDisplayName = async (roomId: string, userId: string): Promise<string> => {
    const cacheKey = `${roomId}:${userId}`;
    const cached = memberDisplayNameCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    let memberState: Record<string, unknown>;
    try {
      memberState = await client.getRoomStateEvent(roomId, "m.room.member", userId);
    } catch {
      // A transient homeserver failure is not authoritative room state; retry
      // the next lookup instead of pinning the fallback user ID for the session.
      return userId;
    }
    const displayName =
      memberState && typeof memberState.displayname === "string" ? memberState.displayname : userId;
    setBoundedMap(memberDisplayNameCache, cacheKey, displayName, MAX_MEMBER_DISPLAY_NAMES);
    return displayName;
  };

  const invalidateMemberDisplayName = (roomId: string, userId: string): void => {
    memberDisplayNameCache.delete(`${roomId}:${userId}`);
  };

  const invalidateRoomName = (roomId: string): void => {
    // An unresolved entry keeps current-name reads retryable without changing the first-name cache.
    setBoundedMap(
      currentRoomNameCache,
      roomId,
      { value: undefined, resolved: false },
      MAX_ROOM_INFO,
    );
  };

  return {
    getRoomInfo,
    getMemberDisplayName,
    invalidateMemberDisplayName,
    invalidateRoomName,
  };
}
