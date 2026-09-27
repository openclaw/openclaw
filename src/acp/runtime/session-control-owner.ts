import type { SessionEntry } from "../../config/sessions/types.js";

/** ACP task control keeps the spawner authoritative over a navigation parent. */
export function resolveAcpSessionControlOwner(
  entry: Pick<SessionEntry, "spawnedBy" | "parentSessionKey"> | undefined,
): string | undefined {
  return entry?.spawnedBy?.trim() || entry?.parentSessionKey?.trim();
}

/** A cleanup target constraint; live task and actor authority remain separate. */
export type AcpSessionControlBinding = Readonly<{
  sessionId: string;
  lifecycleRevision?: string;
  sessionStartedAt?: number;
  ownerKey: string;
}>;

export function matchesAcpSessionControlBinding(
  entry: SessionEntry | undefined,
  expected: AcpSessionControlBinding,
): boolean {
  return Boolean(
    entry &&
    entry.sessionId === expected.sessionId &&
    entry.lifecycleRevision === expected.lifecycleRevision &&
    (expected.lifecycleRevision !== undefined ||
      entry.sessionStartedAt === expected.sessionStartedAt) &&
    resolveAcpSessionControlOwner(entry) === expected.ownerKey,
  );
}
