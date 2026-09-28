import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";

export type AcpSessionRuntimeLocator = Readonly<
  Pick<SessionAcpMeta, "backend" | "runtimeSessionName">
>;

/** Runtime names are opaque backend locators; ordinary metadata enrichment may continue. */
export function matchesAcpSessionRuntimeLocator(
  current: AcpSessionRuntimeLocator | undefined,
  expected: AcpSessionRuntimeLocator,
): boolean {
  return (
    current?.backend === expected.backend &&
    current.runtimeSessionName === expected.runtimeSessionName
  );
}

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
