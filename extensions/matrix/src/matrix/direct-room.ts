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
}): boolean {
  const selfUserId = trimMaybeString(params.selfUserId);
  const remoteUserId = trimMaybeString(params.remoteUserId);
  const joinedMembers = params.joinedMembers ?? [];
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

export async function isStrictDirectRoom(params: {
  client: MatrixClient;
  roomId: string;
  remoteUserId: string;
  selfUserId?: string | null;
}): Promise<boolean> {
  const selfUserId =
    trimMaybeString(params.selfUserId) ??
    trimMaybeString(await params.client.getUserId().catch(() => null));
  if (!selfUserId) {
    return false;
  }
  const joinedMembers = await readJoinedMatrixMembers(params.client, params.roomId);
  return isStrictDirectMembership({
    selfUserId,
    remoteUserId: params.remoteUserId,
    joinedMembers,
  });
}
