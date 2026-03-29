import type { MatrixClient } from "./sdk.js";

function trimMaybeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeJoinedMatrixMembers(joinedMembers: unknown): string[] {
  if (!Array.isArray(joinedMembers)) {
    return [];
  }
  return joinedMembers
    .map((entry) => trimMaybeString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function isStrictDirectMembership(params: {
  selfUserId?: string | null;
  remoteUserId?: string | null;
  joinedMembers?: readonly string[] | null;
  isDirectFlag?: boolean | null;
}): boolean {
  const selfUserId = trimMaybeString(params.selfUserId);
  const remoteUserId = trimMaybeString(params.remoteUserId);
  const joinedMembers = params.joinedMembers ?? [];

  // Priority 1: is_direct flag is authoritative (Matrix protocol standard)
  if (params.isDirectFlag === true) {
    return Boolean(
      selfUserId &&
      remoteUserId &&
      joinedMembers.includes(selfUserId) &&
      joinedMembers.includes(remoteUserId),
    );
  }

  // Priority 2: explicit is_direct=false means not a DM
  if (params.isDirectFlag === false) {
    return false;
  }

  // Priority 3: fallback to 2-member check only when is_direct is unavailable
  return Boolean(
    selfUserId &&
    remoteUserId &&
    joinedMembers.length === 2 &&
    joinedMembers.includes(selfUserId) &&
    joinedMembers.includes(remoteUserId),
  );
}

export async function readJoinedMatrixMembers(
  client: MatrixClient,
  roomId: string,
): Promise<string[] | null> {
  try {
    return normalizeJoinedMatrixMembers(await client.getJoinedRoomMembers(roomId));
  } catch {
    return null;
  }
}

export async function hasDirectMatrixMemberFlag(
  client: MatrixClient,
  roomId: string,
  userId?: string | null,
): Promise<boolean> {
  const normalizedUserId = trimMaybeString(userId);
  if (!normalizedUserId) {
    return false;
  }
  try {
    const state = await client.getRoomStateEvent(roomId, "m.room.member", normalizedUserId);
    return state?.is_direct === true;
  } catch {
    return false;
  }
}

export type MatrixDirectRoomEvidence = {
  joinedMembers: string[] | null;
  strict: boolean;
  viaMemberState: boolean;
};

export async function inspectMatrixDirectRoomEvidence(params: {
  client: MatrixClient;
  roomId: string;
  remoteUserId: string;
  selfUserId?: string | null;
}): Promise<MatrixDirectRoomEvidence> {
  const selfUserId =
    params.selfUserId !== undefined
      ? trimMaybeString(params.selfUserId)
      : trimMaybeString(await params.client.getUserId().catch(() => null));
  const joinedMembers = await readJoinedMatrixMembers(params.client, params.roomId);
  const strict = isStrictDirectMembership({
    selfUserId,
    remoteUserId: params.remoteUserId,
    joinedMembers,
  });
  if (!strict) {
    return {
      joinedMembers,
      strict: false,
      viaMemberState: false,
    };
  }
  return {
    joinedMembers,
    strict,
    viaMemberState:
      (await hasDirectMatrixMemberFlag(params.client, params.roomId, params.remoteUserId)) ||
      (await hasDirectMatrixMemberFlag(params.client, params.roomId, selfUserId)),
  };
}

export async function isStrictDirectRoom(params: {
  client: MatrixClient;
  roomId: string;
  remoteUserId: string;
  selfUserId?: string | null;
}): Promise<boolean> {
  return (
    await inspectMatrixDirectRoomEvidence({
      client: params.client,
      roomId: params.roomId,
      remoteUserId: params.remoteUserId,
      selfUserId: params.selfUserId,
    })
  ).strict;
}
