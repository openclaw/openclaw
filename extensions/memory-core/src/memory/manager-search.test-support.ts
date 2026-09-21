import type { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function insertKeywordFixture(
  db: DatabaseSync,
  params: {
    id: string;
    path: string;
    text?: string;
    source?: "memory" | "sessions";
    model?: string;
    startLine?: number;
    endLine?: number;
  },
): void {
  const {
    id,
    path,
    text = "unrelated body",
    source = "memory",
    model = "mock-embed",
    startLine = 1,
    endLine = 2,
  } = params;
  db.prepare(
    "INSERT OR IGNORE INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 0, 0)",
  ).run(path, source, `${path}:${source}:hash`);
  db.prepare(
    "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    path,
    source,
    startLine,
    endLine,
    `${id}:hash`,
    model,
    text,
    JSON.stringify([0]),
    Date.now(),
  );
  db.prepare(
    "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(text, id, path, source, model, startLine, endLine);
}

export function createMemorySearchDb(options: { ftsTokenizer?: "unicode61" | "trigram" } = {}) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  try {
    const schema = ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: true,
      ...options,
    });
    return { db, schema };
  } catch (error) {
    db.close();
    throw error;
  }
}
