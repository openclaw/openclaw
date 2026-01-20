import type { MatrixClient } from "matrix-bot-sdk";

import { EventType, type MatrixDirectAccountData } from "./types.js";

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Matrix target is required (room:<id> or #alias)");
  }
  return trimmed;
}

export function normalizeThreadId(raw?: string | number | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : null;
}

async function resolveDirectRoomId(client: MatrixClient, userId: string): Promise<string> {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);
  }
  // matrix-bot-sdk: use getAccountData to retrieve m.direct
  try {
    const directContent = await client.getAccountData(EventType.Direct) as MatrixDirectAccountData | null;
    const list = Array.isArray(directContent?.[trimmed]) ? directContent[trimmed] : [];
    if (list.length > 0) return list[0];
  } catch {
    // Ignore errors, try fetching from server
  }
  throw new Error(
    `No m.direct room found for ${trimmed}. Open a DM first so Matrix can set m.direct.`,
  );
}

export async function resolveMatrixRoomId(
  client: MatrixClient,
  raw: string,
): Promise<string> {
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
