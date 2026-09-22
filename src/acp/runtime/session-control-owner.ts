import type { SessionEntry } from "../../config/sessions/types.js";

/** ACP task control keeps the spawner authoritative over a navigation parent. */
export function resolveAcpSessionControlOwner(
  entry: Pick<SessionEntry, "spawnedBy" | "parentSessionKey"> | undefined,
): string | undefined {
  return entry?.spawnedBy?.trim() || entry?.parentSessionKey?.trim();
}
