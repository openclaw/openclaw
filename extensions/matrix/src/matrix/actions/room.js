import { resolveMatrixRoomId } from "../send.js";
import { resolveActionClient } from "./client.js";
import { EventType } from "./types.js";
async function getMatrixMemberInfo(userId, opts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const roomId = opts.roomId ? await resolveMatrixRoomId(client, opts.roomId) : void 0;
    const profile = await client.getUserProfile(userId);
    return {
      userId,
      profile: {
        displayName: profile?.displayname ?? null,
        avatarUrl: profile?.avatar_url ?? null
      },
      membership: null,
      // Would need separate room state query
      powerLevel: null,
      // Would need separate power levels state query
      displayName: profile?.displayname ?? null,
      roomId: roomId ?? null
    };
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
async function getMatrixRoomInfo(roomId, opts = {}) {
  const { client, stopOnDone } = await resolveActionClient(opts);
  try {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    let name = null;
    let topic = null;
    let canonicalAlias = null;
    let memberCount = null;
    try {
      const nameState = await client.getRoomStateEvent(resolvedRoom, "m.room.name", "");
      name = nameState?.name ?? null;
    } catch {
    }
    try {
      const topicState = await client.getRoomStateEvent(resolvedRoom, EventType.RoomTopic, "");
      topic = topicState?.topic ?? null;
    } catch {
    }
    try {
      const aliasState = await client.getRoomStateEvent(resolvedRoom, "m.room.canonical_alias", "");
      canonicalAlias = aliasState?.alias ?? null;
    } catch {
    }
    try {
      const members = await client.getJoinedRoomMembers(resolvedRoom);
      memberCount = members.length;
    } catch {
    }
    return {
      roomId: resolvedRoom,
      name,
      topic,
      canonicalAlias,
      altAliases: [],
      // Would need separate query
      memberCount
    };
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
export {
  getMatrixMemberInfo,
  getMatrixRoomInfo
};
