import { filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixRoomId } from "../send.js";
import { withResolvedActionClient, withResolvedRoomAction } from "./client.js";
import { EventType, type MatrixActionClientOpts } from "./types.js";

export async function getMatrixMemberInfo(
  userId: string,
  opts: MatrixActionClientOpts & { roomId: string },
) {
  return await withResolvedActionClient(opts, async (client) => {
    const roomId = await resolveMatrixRoomId(client, opts.roomId);
    const members = await client.getJoinedRoomMembers(roomId);
    if (!members.includes(userId)) {
      throw new Error(`User ${userId} is not a member of room ${roomId}`);
    }
    const profile = await client.getUserProfile(userId);
    // Membership and power levels are not included in profile calls; fetch state separately if needed.
    return {
      userId,
      profile: {
        displayName: profile?.displayname ?? null,
        avatarUrl: profile?.avatar_url ?? null,
      },
      membership: null, // Would need separate room state query
      powerLevel: null, // Would need separate power levels state query
      displayName: profile?.displayname ?? null,
      roomId,
    };
  });
}

export async function getMatrixRoomInfo(roomId: string, opts: MatrixActionClientOpts = {}) {
  return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
    const name = await client
      .getRoomStateEvent(resolvedRoom, "m.room.name", "")
      .then((state) => (typeof state?.name === "string" ? state.name : null))
      .catch(() => null);
    const topic = await client
      .getRoomStateEvent(resolvedRoom, EventType.RoomTopic, "")
      .then((state) => (typeof state?.topic === "string" ? state.topic : null))
      .catch(() => null);
    const aliases = await client
      .getRoomStateEvent(resolvedRoom, "m.room.canonical_alias", "")
      .then((state) => ({
        canonicalAlias: typeof state?.alias === "string" ? state.alias : null,
        altAliases: filterStringEntries(state?.alt_aliases),
      }))
      .catch(() => ({ canonicalAlias: null, altAliases: [] }));
    const memberCount = await client
      .getJoinedRoomMembers(resolvedRoom)
      .then((members) => members.length)
      .catch(() => null);

    return {
      roomId: resolvedRoom,
      name,
      topic,
      ...aliases,
      memberCount,
    };
  });
}
