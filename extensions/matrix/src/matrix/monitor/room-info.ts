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

  function createRoomStateResolver<T>(
    eventType: string,
    project: (state: Record<string, unknown> | undefined) => T,
  ) {
    const cache = new Map<string, { value: T; resolved: boolean }>();
    return async (roomId: string) => {
      const cached = cache.get(roomId);
      if (cached) {
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

  const getRoomName = createRoomStateResolver("m.room.name", (state) =>
    typeof state?.name === "string" ? state.name : undefined,
  );
  const getRoomAliases = createRoomStateResolver("m.room.canonical_alias", (state) => ({
    canonicalAlias: typeof state?.alias === "string" ? state.alias : undefined,
    altAliases: Array.isArray(state?.alt_aliases)
      ? state.alt_aliases.filter((entry): entry is string => typeof entry === "string")
      : [],
  }));

  const getRoomInfo = async (
    roomId: string,
    opts: { includeAliases?: boolean } = {},
  ): Promise<MatrixRoomInfo> => {
    const { value: name, resolved: nameResolved } = await getRoomName(roomId);
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

  return {
    getRoomInfo,
    getMemberDisplayName,
    invalidateMemberDisplayName,
  };
}
