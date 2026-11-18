import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectMatrixDirectRooms, persistMatrixDirectRoomMapping } from "../direct-management.js";
import { isStrictDirectRoom } from "../direct-room.js";
import { setBoundedMap } from "../monitor/bounded-cache.js";
import type { MatrixClient } from "../sdk.js";
import { captureMatrixSendCurrentness } from "../sdk/send-currentness.js";
import { isMatrixQualifiedUserId, normalizeMatrixResolvableTarget } from "../target-ids.js";

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Matrix target is required (room:<id> or #alias)");
  }
  return trimmed;
}

export function normalizeThreadId(raw?: string | number | null): string | null {
  return normalizeOptionalStringifiedId(raw) ?? null;
}

// Size-capped to prevent unbounded growth (#4948)
const MAX_DIRECT_ROOM_CACHE_SIZE = 1024;
const directRoomCacheByClient = new WeakMap<MatrixClient, Map<string, string>>();

function resolveDirectRoomCache(client: MatrixClient): Map<string, string> {
  const existing = directRoomCacheByClient.get(client);
  if (existing) {
    return existing;
  }
  const created = new Map<string, string>();
  directRoomCacheByClient.set(client, created);
  return created;
}

async function resolveDirectRoomId(
  client: MatrixClient,
  userId: string,
  persistDirectMapping: boolean,
): Promise<string> {
  const trimmed = userId.trim();
  if (!isMatrixQualifiedUserId(trimmed)) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);
  }
  const selfUserId = (await client.getUserId().catch(() => null))?.trim() || null;

  const directRoomCache = resolveDirectRoomCache(client);
  // A read lookup must not suppress mapping repair on a later send.
  const cacheKey = persistDirectMapping ? trimmed : `read:${trimmed}`;
  const cached = directRoomCache.get(cacheKey);
  if (
    cached &&
    (await isStrictDirectRoom({ client, roomId: cached, remoteUserId: trimmed, selfUserId }))
  ) {
    return cached;
  }
  if (cached) {
    directRoomCache.delete(cacheKey);
  }

  const inspection = await inspectMatrixDirectRooms({
    client,
    remoteUserId: trimmed,
  });
  if (inspection.activeRoomId) {
    if (persistDirectMapping && inspection.mappedRoomIds[0] !== inspection.activeRoomId) {
      await persistMatrixDirectRoomMapping({
        client,
        remoteUserId: trimmed,
        roomId: inspection.activeRoomId,
      }).catch(() => {
        // A canceled repair must not cache a lookup that suppresses the next valid repair.
        captureMatrixSendCurrentness(client)?.();
        // Ignore persistence errors when send resolution has already found a usable room.
      });
    }
    setBoundedMap(directRoomCache, cacheKey, inspection.activeRoomId, MAX_DIRECT_ROOM_CACHE_SIZE);
    return inspection.activeRoomId;
  }

  throw new Error(`No direct room found for ${trimmed} (m.direct missing)`);
}

export async function resolveMatrixRoomId(
  client: MatrixClient,
  raw: string,
  opts: { persistDirectMapping?: boolean } = {},
): Promise<string> {
  const target = normalizeMatrixResolvableTarget(normalizeTarget(raw));
  const lowered = normalizeLowercaseStringOrEmpty(target);
  if (lowered.startsWith("user:")) {
    return await resolveDirectRoomId(
      client,
      target.slice("user:".length),
      opts.persistDirectMapping ?? true,
    );
  }
  if (isMatrixQualifiedUserId(target)) {
    return await resolveDirectRoomId(client, target, opts.persistDirectMapping ?? true);
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
