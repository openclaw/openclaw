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
const MAX_DIRECT_ROOM_CACHE_ORDER_SIZE = MAX_DIRECT_ROOM_CACHE_SIZE * 2;
type DirectRoomCacheEntry = {
  roomId: string;
  evicted: boolean;
};

const directRoomCache = new WeakMap<MatrixClient, Map<string, DirectRoomCacheEntry>>();
const directRoomCacheOrder: Array<{
  clientCache: Map<string, DirectRoomCacheEntry>;
  userId: string;
  entry: DirectRoomCacheEntry;
}> = [];
let directRoomCacheSize = 0;
let directRoomCacheEvictedCount = 0;

function markDirectRoomCacheEntryEvicted(entry: DirectRoomCacheEntry): void {
  if (entry.evicted) {
    return;
  }
  entry.evicted = true;
  directRoomCacheEvictedCount += 1;
}

function maybeCompactDirectRoomCacheOrder(): void {
  if (directRoomCacheEvictedCount === 0) {
    return;
  }
  if (
    directRoomCacheOrder.length <= MAX_DIRECT_ROOM_CACHE_ORDER_SIZE &&
    directRoomCacheEvictedCount <= MAX_DIRECT_ROOM_CACHE_SIZE
  ) {
    return;
  }
  const compacted = directRoomCacheOrder.filter((slot) => !slot.entry.evicted);
  directRoomCacheOrder.splice(0, directRoomCacheOrder.length, ...compacted);
  directRoomCacheEvictedCount = 0;
}

function getDirectRoomCacheForClient(client: MatrixClient): Map<string, DirectRoomCacheEntry> {
  const existing = directRoomCache.get(client);
  if (existing) {
    return existing;
  }
  const created = new Map<string, DirectRoomCacheEntry>();
  directRoomCache.set(client, created);
  return created;
}

function getDirectRoomCached(client: MatrixClient, userId: string): string | null {
  const clientCache = directRoomCache.get(client);
  return clientCache?.get(userId)?.roomId ?? null;
}

function clearDirectRoomCacheEntry(client: MatrixClient, userId: string): void {
  const clientCache = directRoomCache.get(client);
  const existing = clientCache?.get(userId);
  if (!clientCache || !existing) {
    return;
  }
  markDirectRoomCacheEntryEvicted(existing);
  clientCache.delete(userId);
  directRoomCacheSize -= 1;
  maybeCompactDirectRoomCacheOrder();
}

function setDirectRoomCached(client: MatrixClient, userId: string, roomId: string): void {
  const clientCache = getDirectRoomCacheForClient(client);
  const previous = clientCache.get(userId);
  if (previous) {
    markDirectRoomCacheEntryEvicted(previous);
    directRoomCacheSize -= 1;
  }

  const entry: DirectRoomCacheEntry = { roomId, evicted: false };
  clientCache.set(userId, entry);
  directRoomCacheOrder.push({ clientCache, userId, entry });
  directRoomCacheSize += 1;

  while (directRoomCacheSize > MAX_DIRECT_ROOM_CACHE_SIZE) {
    const oldest = directRoomCacheOrder.shift();
    if (!oldest) {
      continue;
    }
    if (oldest.entry.evicted) {
      directRoomCacheEvictedCount -= 1;
      continue;
    }
    oldest.entry.evicted = true;
    oldest.clientCache.delete(oldest.userId);
    directRoomCacheSize -= 1;
  }

  maybeCompactDirectRoomCacheOrder();
}

function normalizeRoomIdList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
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

  const cached = getDirectRoomCached(client, trimmed);
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
    directList = normalizeRoomIdList(directContent?.[trimmed]);
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
  const directIndexByRoomId = new Map<string, number>();
  directList.forEach((roomId, index) => {
    directIndexByRoomId.set(roomId, index);
    candidateIds.add(roomId);
  });
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
      const directIndex = directIndexByRoomId.get(roomId);
      const hasDirectUserFlag = await hasDirectFlag(client, roomId, trimmed);
      const hasDirectSelfFlag = await hasDirectFlag(client, roomId, selfUserId);
      const hasExplicitName =
        members.length === 2 ? await getRoomHasExplicitName(client, roomId) : true;

      candidates.push({
        roomId,
        directIndex: directIndex ?? null,
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
    setDirectRoomCached(client, trimmed, bestCandidate.roomId);
    if (directList[0] !== bestCandidate.roomId) {
      await persistDirectRoom(client, trimmed, bestCandidate.roomId);
    }
    return bestCandidate.roomId;
  }

  if (directList[0]) {
    setDirectRoomCached(client, trimmed, directList[0]);
    return directList[0];
  }

  throw new Error(`No direct room found for ${trimmed} (m.direct missing)`);
}

function isPrefixedMatrixTarget(target: string, prefix: string): boolean {
  return target.toLowerCase().startsWith(prefix);
}

export function isMatrixUserTarget(raw: string): boolean {
  const target = normalizeTarget(raw);
  if (isPrefixedMatrixTarget(target, "matrix:")) {
    return isMatrixUserTarget(target.slice("matrix:".length));
  }
  if (isPrefixedMatrixTarget(target, "room:")) {
    return isMatrixUserTarget(target.slice("room:".length));
  }
  if (isPrefixedMatrixTarget(target, "channel:")) {
    return isMatrixUserTarget(target.slice("channel:".length));
  }
  if (isPrefixedMatrixTarget(target, "user:")) {
    return target.slice("user:".length).trim().startsWith("@");
  }
  return target.startsWith("@");
}

export function clearDirectRoomCacheForTarget(client: MatrixClient, raw: string): void {
  if (!isMatrixUserTarget(raw)) {
    return;
  }
  const target = normalizeTarget(raw);
  if (isPrefixedMatrixTarget(target, "matrix:")) {
    clearDirectRoomCacheForTarget(client, target.slice("matrix:".length));
    return;
  }
  if (isPrefixedMatrixTarget(target, "room:")) {
    clearDirectRoomCacheForTarget(client, target.slice("room:".length));
    return;
  }
  if (isPrefixedMatrixTarget(target, "channel:")) {
    clearDirectRoomCacheForTarget(client, target.slice("channel:".length));
    return;
  }
  if (isPrefixedMatrixTarget(target, "user:")) {
    clearDirectRoomCacheEntry(client, target.slice("user:".length).trim());
    return;
  }
  clearDirectRoomCacheEntry(client, target);
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

type TargetsTestHooks = {
  getDirectRoomCacheOrderLength(): number;
  getMaxDirectRoomCacheOrderSize(): number;
};

(
  globalThis as typeof globalThis & {
    __openclawMatrixTargetsTestHooks__?: TargetsTestHooks;
  }
).__openclawMatrixTargetsTestHooks__ = {
  getDirectRoomCacheOrderLength: () => directRoomCacheOrder.length,
  getMaxDirectRoomCacheOrderSize: () => MAX_DIRECT_ROOM_CACHE_ORDER_SIZE,
};
