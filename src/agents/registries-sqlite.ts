/**
 * SQLite adapter for agent marketplace registries
 * (replaces ~/.openclaw/agent-registry-cache/registries.json).
 */
import { getStateDb } from "../infra/state-db/connection.js";

export interface StoredAgentRegistry {
  id: string;
  name: string;
  url: string;
  description?: string;
  visibility: "public" | "private";
  authTokenEnv?: string;
  enabled: boolean;
  lastSynced?: string;
  agentCount?: number;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function loadAgentRegistriesFromDb(): StoredAgentRegistry[] {
  const db = getStateDb();
  const rows = db
    .prepare(
      "SELECT id, name, url, description, auth_token_env, visibility, enabled, last_synced, agent_count FROM op1_agent_registries ORDER BY name",
    )
    .all() as Array<{
    id: string;
    name: string;
    url: string;
    description: string | null;
    auth_token_env: string | null;
    visibility: string | null;
    enabled: number;
    last_synced: string | null;
    agent_count: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    description: r.description ?? undefined,
    visibility: r.visibility === "private" ? "private" : "public",
    authTokenEnv: r.auth_token_env ?? undefined,
    enabled: r.enabled !== 0,
    lastSynced: r.last_synced ?? undefined,
    agentCount: r.agent_count ?? undefined,
  }));
}

// ── Write ────────────────────────────────────────────────────────────────────

export function saveAgentRegistryToDb(registry: StoredAgentRegistry): void {
  const db = getStateDb();
  db.prepare(
    `INSERT INTO op1_agent_registries (id, name, url, description, auth_token_env, visibility, enabled, last_synced, agent_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       url = excluded.url,
       description = excluded.description,
       auth_token_env = excluded.auth_token_env,
       visibility = excluded.visibility,
       enabled = excluded.enabled,
       last_synced = excluded.last_synced,
       agent_count = excluded.agent_count,
       updated_at = unixepoch()`,
  ).run(
    registry.id,
    registry.name,
    registry.url,
    registry.description ?? null,
    registry.authTokenEnv ?? null,
    registry.visibility,
    registry.enabled ? 1 : 0,
    registry.lastSynced ?? null,
    registry.agentCount ?? 0,
  );
}

export function deleteAgentRegistryFromDb(id: string): boolean {
  const db = getStateDb();
  const result = db.prepare("DELETE FROM op1_agent_registries WHERE id = ?").run(id);
  return (result.changes as number) > 0;
}

export function updateAgentRegistrySyncState(
  id: string,
  lastSynced: string,
  agentCount: number,
): void {
  const db = getStateDb();
  db.prepare(
    "UPDATE op1_agent_registries SET last_synced = ?, agent_count = ?, updated_at = unixepoch() WHERE id = ?",
  ).run(lastSynced, agentCount, id);
}
