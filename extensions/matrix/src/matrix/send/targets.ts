import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { EventType, type MatrixDirectAccountData } from "./types.js";

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Matrix target is required (room:<id> or #alias)");
  }
  return trimmed;
}

export function normalizeThreadId(raw?: string | number | null): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : null;
}

// Size-capped to prevent unbounded growth (#4948)
const MAX_DIRECT_ROOM_CACHE_SIZE = 1024;
const directRoomCache = new Map<string, string>();
const clientIds = new WeakMap<MatrixClient, number>();
let nextClientId = 1;

function getDirectRoomCacheKey(client: MatrixClient, userId: string): string {
  const existing = clientIds.get(client);
  if (existing) {
    return `${existing}:${userId}`;
  }
  const created = nextClientId++;
  clientIds.set(client, created);
  return `${created}:${userId}`;
}

function setDirectRoomCached(key: string, value: string): void {
  directRoomCache.set(key, value);
  if (directRoomCache.size > MAX_DIRECT_ROOM_CACHE_SIZE) {
    const oldest = directRoomCache.keys().next().value;
    if (oldest !== undefined) {
      directRoomCache.delete(oldest);
    }
  }
}

function isMatrixNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const candidate = err as { errcode?: string; statusCode?: number };
  return candidate.errcode === "M_NOT_FOUND" || candidate.statusCode === 404;
}

async function getSelfUserId(client: MatrixClient): Promise<string | null> {
  try {
    return await client.getUserId();
  } catch {
    return null;
  }
}

async function hasDirectFlag(
  client: MatrixClient,
  roomId: string,
  userId: string | null,
): Promise<boolean> {
  if (!userId) {
    return false;
  }
  try {
    const state = await client.getRoomStateEvent(roomId, "m.room.member", userId);
    return state?.is_direct === true;
  } catch {
    return false;
  }
}

async function getRoomHasExplicitName(client: MatrixClient, roomId: string): Promise<boolean> {
  try {
    const nameState = await client.getRoomStateEvent(roomId, "m.room.name", "");
    return Boolean(nameState?.name?.trim());
  } catch (err) {
    if (isMatrixNotFoundError(err)) {
      return false;
    }
    return true;
  }
}

type DirectRoomCandidate = {
  roomId: string;
  directIndex: number | null;
  dmCached: boolean;
  hasDirectFlag: boolean;
  memberCount: number;
  hasExplicitName: boolean;
};

function scoreDirectRoomCandidate(candidate: DirectRoomCandidate): number {
  let score = 0;
  if (candidate.dmCached) {
    score += 1000;
  }
  if (candidate.hasDirectFlag) {
    score += 500;
  }
  if (candidate.memberCount === 2 && !candidate.hasExplicitName) {
    score += 250;
  }
  if (candidate.directIndex !== null) {
    score += 100 - Math.min(candidate.directIndex, 100);
  }
  if (candidate.memberCount === 2) {
    score += 25;
  }
  if (candidate.hasExplicitName) {
    score -= 25;
  }
  return score;
}

async function persistDirectRoom(
  client: MatrixClient,
  userId: string,
  roomId: string,
): Promise<void> {
  let directContent: MatrixDirectAccountData | null = null;
  try {
    directContent = await client.getAccountData(EventType.Direct);
  } catch {
    // Ignore fetch errors and fall back to an empty map.
  }
  const existing = directContent && !Array.isArray(directContent) ? directContent : {};
  const current = Array.isArray(existing[userId]) ? existing[userId] : [];
  if (current[0] === roomId) {
    return;
  }
  const next = [roomId, ...current.filter((id) => id !== roomId)];
  try {
    await client.setAccountData(EventType.Direct, {
      ...existing,
      [userId]: next,
    });
  } catch {
    // Ignore persistence errors.
  }
}

async function resolveDirectRoomId(client: MatrixClient, userId: string): Promise<string> {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);
  }

  const cacheKey = getDirectRoomCacheKey(client, trimmed);
  const cached = directRoomCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 1) Gather the bot's direct-room hints for this specific Matrix account.
  let directList: string[] = [];
  try {
    const directContent = (await client.getAccountData(EventType.Direct)) as Record<
      string,
      string[] | undefined
    >;
    directList = Array.isArray(directContent?.[trimmed]) ? directContent[trimmed] : [];
  } catch {
    // Ignore and fall back.
  }

  try {
    await client.dms?.update?.();
  } catch {
    // Ignore DM cache refresh failures and keep going.
  }

  const selfUserId = await getSelfUserId(client);
  const joinedRooms = await client.getJoinedRooms().catch(() => []);
  const joinedSet = new Set(joinedRooms);
  const candidateIds = new Set<string>();
  directList.forEach((roomId) => candidateIds.add(roomId));
  joinedRooms.forEach((roomId) => candidateIds.add(roomId));

  const candidates: DirectRoomCandidate[] = [];
  try {
    for (const roomId of candidateIds) {
      if (!joinedSet.has(roomId)) {
        continue;
      }

      let members: string[];
      try {
        members = await client.getJoinedRoomMembers(roomId);
      } catch {
        continue;
      }
      if (!members.includes(trimmed)) {
        continue;
      }

      const dmCached = client.dms?.isDm?.(roomId) === true;
      const directIndex = directList.indexOf(roomId);
      const hasDirectUserFlag = await hasDirectFlag(client, roomId, trimmed);
      const hasDirectSelfFlag = await hasDirectFlag(client, roomId, selfUserId);
      const hasExplicitName =
        members.length === 2 ? await getRoomHasExplicitName(client, roomId) : true;

      candidates.push({
        roomId,
        directIndex: directIndex >= 0 ? directIndex : null,
        dmCached,
        hasDirectFlag: hasDirectUserFlag || hasDirectSelfFlag,
        memberCount: members.length,
        hasExplicitName,
      });
    }
  } catch {
    // Ignore and fall back.
  }

  const bestCandidate = [...candidates].sort((left, right) => {
    const scoreDelta = scoreDirectRoomCandidate(right) - scoreDirectRoomCandidate(left);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    if (left.directIndex !== null && right.directIndex !== null) {
      return left.directIndex - right.directIndex;
    }
    if (left.directIndex !== null) {
      return -1;
    }
    if (right.directIndex !== null) {
      return 1;
    }
    return left.memberCount - right.memberCount;
  })[0];

  if (bestCandidate) {
    setDirectRoomCached(cacheKey, bestCandidate.roomId);
    if (directList[0] !== bestCandidate.roomId) {
      await persistDirectRoom(client, trimmed, bestCandidate.roomId);
    }
    return bestCandidate.roomId;
  }

  if (directList[0]) {
    setDirectRoomCached(cacheKey, directList[0]);
    return directList[0];
  }

  throw new Error(`No direct room found for ${trimmed} (m.direct missing)`);
}

export async function resolveMatrixRoomId(client: MatrixClient, raw: string): Promise<string> {
  const target = normalizeTarget(raw);
  const lowered = target.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    return await resolveMatrixRoomId(client, target.slice("matrix:".length));
  }
  if (lowered.startsWith("room:")) {
    return await resolveMatrixRoomId(client, target.slice("room:".length));
  }
  if (lowered.startsWith("channel:")) {
    return await resolveMatrixRoomId(client, target.slice("channel:".length));
  }
  if (lowered.startsWith("user:")) {
    return await resolveDirectRoomId(client, target.slice("user:".length));
  }
  if (target.startsWith("@")) {
    return await resolveDirectRoomId(client, target);
  }
  if (target.startsWith("#")) {
    const resolved = await client.resolveRoom(target);
    if (!resolved) {
      throw new Error(`Matrix alias ${target} could not be resolved`);
    }
    return resolved;
  }
  return target;
}
