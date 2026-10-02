// Memory Host SDK module owns additive memory chunk provenance schema.
import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "./openclaw-runtime-sqlite.js";

export const MEMORY_INDEX_CHUNK_PROVENANCE_TABLE = "memory_index_chunk_provenance";

export const MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} (
    chunk_id TEXT PRIMARY KEY,
    origin_class TEXT NOT NULL CHECK (origin_class IN ('owner', 'agent', 'untrusted', 'system')),
    session_kind TEXT NOT NULL CHECK (session_kind IN ('interactive', 'cron', 'heartbeat', 'subagent', 'unknown')),
    observed_at INTEGER NOT NULL,
    supersedes_key TEXT,
    FOREIGN KEY (chunk_id) REFERENCES memory_index_chunks(id) ON DELETE CASCADE
  ) STRICT;
`;

const missingChunkIdsSql = `
  SELECT chunk.id
  FROM memory_index_chunks AS chunk
  LEFT JOIN ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} AS provenance
    ON provenance.chunk_id = chunk.id
  WHERE provenance.chunk_id IS NULL
`;

export function ensureMemoryChunkProvenance(db: DatabaseSync): void {
  const ensure = () => {
    // The former chunk trigger made the additive table visible to older schema
    // validators. Writers upsert provenance explicitly; this backfill covers
    // legacy/imported rows without changing the canonical chunk table.
    db.exec("DROP TRIGGER IF EXISTS memory_index_chunk_provenance_after_insert");
    db.exec(MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL);
    // Materialize indexed missing IDs before touching wide chunk payloads.
    // CROSS JOIN keeps that empty-set check ahead of the chunk-table lookup.
    db.exec(`
      WITH missing AS MATERIALIZED (${missingChunkIdsSql}),
      affected AS MATERIALIZED (
        SELECT chunk.path, chunk.source
        FROM missing
        CROSS JOIN memory_index_chunks AS chunk ON chunk.id = missing.id
      )
      UPDATE memory_index_sources
      SET hash = ''
      WHERE EXISTS (
        SELECT 1
        FROM affected
        WHERE affected.path = memory_index_sources.path
          AND affected.source IS memory_index_sources.source
      );

      WITH missing AS MATERIALIZED (${missingChunkIdsSql})
      INSERT OR IGNORE INTO ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} (
        chunk_id, origin_class, session_kind, observed_at
      )
      SELECT chunk.id, 'untrusted', 'unknown', chunk.updated_at
      FROM missing
      JOIN memory_index_chunks AS chunk ON chunk.id = missing.id;
    `);
  };
  if (db.isTransaction) {
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
}
