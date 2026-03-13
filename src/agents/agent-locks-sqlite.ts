/**
 * SQLite adapter for agent lock entries
 * (replaces agents-lock.yaml / agents.local-lock.yaml per scope).
 */
import { getStateDb } from "../infra/state-db/connection.js";

export interface StoredAgentLock {
  agentId: string;
  scope: string;
  version: string;
  resolved?: string;
  checksum?: string;
  installedAt?: string;
  requires?: string;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** Load all lock entries for a given scope. */
export function loadAgentLocksFromDb(scope: string): StoredAgentLock[] {
  const db = getStateDb();
  const rows = db
    .prepare(
      "SELECT agent_id, scope, version, resolved, checksum, installed_at, requires FROM op1_agent_locks WHERE scope = ? ORDER BY agent_id",
    )
    .all(scope) as Array<{
    agent_id: string;
    scope: string;
    version: string;
    resolved: string | null;
    checksum: string | null;
    installed_at: string | null;
    requires: string | null;
  }>;

  return rows.map((r) => ({
    agentId: r.agent_id,
    scope: r.scope,
    version: r.version,
    resolved: r.resolved ?? undefined,
    checksum: r.checksum ?? undefined,
    installedAt: r.installed_at ?? undefined,
    requires: r.requires ?? undefined,
  }));
}

/** Load a single lock entry by agent ID and scope. */
export function getAgentLockFromDb(agentId: string, scope: string): StoredAgentLock | undefined {
  const db = getStateDb();
  const row = db
    .prepare(
      "SELECT agent_id, scope, version, resolved, checksum, installed_at, requires FROM op1_agent_locks WHERE agent_id = ? AND scope = ?",
    )
    .get(agentId, scope) as
    | {
        agent_id: string;
        scope: string;
        version: string;
        resolved: string | null;
        checksum: string | null;
        installed_at: string | null;
        requires: string | null;
      }
    | undefined;

  if (!row) {
    return undefined;
  }

  return {
    agentId: row.agent_id,
    scope: row.scope,
    version: row.version,
    resolved: row.resolved ?? undefined,
    checksum: row.checksum ?? undefined,
    installedAt: row.installed_at ?? undefined,
    requires: row.requires ?? undefined,
  };
}

// ── Write ────────────────────────────────────────────────────────────────────

/** Upsert a lock entry. */
export function saveAgentLockToDb(lock: StoredAgentLock): void {
  const db = getStateDb();
  db.prepare(
    `INSERT INTO op1_agent_locks (agent_id, scope, version, resolved, checksum, installed_at, requires, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(agent_id, scope) DO UPDATE SET
       version = excluded.version,
       resolved = excluded.resolved,
       checksum = excluded.checksum,
       installed_at = excluded.installed_at,
       requires = excluded.requires`,
  ).run(
    lock.agentId,
    lock.scope,
    lock.version,
    lock.resolved ?? null,
    lock.checksum ?? null,
    lock.installedAt ?? null,
    lock.requires ?? null,
  );
}

/** Remove a lock entry. */
export function deleteAgentLockFromDb(agentId: string, scope: string): boolean {
  const db = getStateDb();
  const result = db
    .prepare("DELETE FROM op1_agent_locks WHERE agent_id = ? AND scope = ?")
    .run(agentId, scope);
  return (result.changes as number) > 0;
}

/** Remove all lock entries for a scope. */
export function deleteAllAgentLocksForScope(scope: string): number {
  const db = getStateDb();
  const result = db.prepare("DELETE FROM op1_agent_locks WHERE scope = ?").run(scope);
  return result.changes as number;
}
