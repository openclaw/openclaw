import { type DatabaseSync } from "node:sqlite";

/**
 * Minimal registry for shared memory stores.
 *
 * Tracks which agents reference which shared stores via directory hash.
 * Used for observability and diagnostics only — no access control.
 */

const REGISTRY_TABLE = "shared_stores";
const AGENT_REFS_TABLE = "agent_source_refs";

export type StoreRecord = {
  dir_hash: string;
  store_path: string;
  agent_ids: string;
  file_count: number;
  chunk_count: number;
  created_at: number;
  updated_at: number;
};

export type AgentRefRecord = {
  agent_id: string;
  dir_hash: string;
  store_path: string;
  workspace_dir: string;
  created_at: number;
  updated_at: number;
};

export function ensureRegistrySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${REGISTRY_TABLE} (
      dir_hash TEXT PRIMARY KEY,
      store_path TEXT NOT NULL,
      agent_ids TEXT NOT NULL DEFAULT '[]',
      file_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${AGENT_REFS_TABLE} (
      agent_id TEXT NOT NULL,
      dir_hash TEXT NOT NULL,
      store_path TEXT NOT NULL,
      workspace_dir TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, dir_hash)
    );
  `);
}

export function registerAgentForStore(
  db: DatabaseSync,
  params: {
    agentId: string;
    dirHash: string;
    storePath: string;
    workspaceDir: string;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO ${AGENT_REFS_TABLE} (agent_id, dir_hash, store_path, workspace_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, dir_hash) DO UPDATE SET
       store_path=excluded.store_path,
       workspace_dir=excluded.workspace_dir,
       updated_at=excluded.updated_at`,
  ).run(params.agentId, params.dirHash, params.storePath, params.workspaceDir, now, now);
  const existing = db
    .prepare(`SELECT agent_ids FROM ${REGISTRY_TABLE} WHERE dir_hash = ?`)
    .get(params.dirHash) as { agent_ids: string } | undefined;
  let agentIds: string[];
  if (existing) {
    const parsed: string[] = JSON.parse(existing.agent_ids);
    agentIds = parsed.includes(params.agentId) ? parsed : [...parsed, params.agentId].toSorted();
  } else {
    agentIds = [params.agentId];
  }
  db.prepare(
    `INSERT INTO ${REGISTRY_TABLE} (dir_hash, store_path, agent_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dir_hash) DO UPDATE SET
       store_path=excluded.store_path,
       agent_ids=excluded.agent_ids,
       updated_at=excluded.updated_at`,
  ).run(params.dirHash, params.storePath, JSON.stringify(agentIds), now, now);
}

export function getStoresForAgent(db: DatabaseSync, agentId: string): AgentRefRecord[] {
  return db
    .prepare(`SELECT * FROM ${AGENT_REFS_TABLE} WHERE agent_id = ? ORDER BY created_at ASC`)
    .all(agentId) as AgentRefRecord[];
}
