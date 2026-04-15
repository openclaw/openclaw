import type { DatabaseSync } from "node:sqlite";

// Additive ingest-only schema. Kept separate from sidecar-schema.ts so Slice 1
// can be reverted independently of the Slice 0 foundation.
//
// - memory_v2_ingest_text holds the normalized form of conversation-derived
//   candidate text, joined by ref_id. Lexical dedupe needs this; the main
//   record table never carries free-form text.
// - The composite (memory_type, last_seen_at) index keeps the dedupe scan
//   bounded; the main records table also gets it because dedupe joins both.
export function ensureIngestSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_v2_ingest_text (
      ref_id TEXT PRIMARY KEY,
      normalized_text TEXT NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_memory_v2_records_type_lastseen
       ON memory_v2_records(memory_type, last_seen_at);`,
  );
}
