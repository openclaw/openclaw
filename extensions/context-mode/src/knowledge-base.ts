/**
 * SQLite FTS5-backed knowledge base for compressed tool outputs.
 *
 * Stores full original tool results and provides full-text search
 * and direct retrieval by reference ID. Uses Node's built-in `node:sqlite`.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CompressedEntry, RecentEntry } from "./types.js";

const require = createRequire(import.meta.url);

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS entries (
    ref_id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    original_chars INTEGER NOT NULL,
    compressed_chars INTEGER NOT NULL,
    full_text TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    tool_name,
    full_text,
    content=entries,
    content_rowid=rowid
  );

  CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
    INSERT INTO entries_fts(rowid, tool_name, full_text)
    VALUES (new.rowid, new.tool_name, new.full_text);
  END;

  CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, tool_name, full_text)
    VALUES ('delete', old.rowid, old.tool_name, old.full_text);
  END;
`;

/**
 * Open (or create) the knowledge base at the given directory.
 * The database file is `context-mode.db` inside the directory.
 */
export function openKnowledgeBase(dir: string): KnowledgeBase {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "context-mode.db");

  // Dynamic import so the module loads even if node:sqlite is unavailable
  // (e.g., older Node versions). The caller should catch and disable.
  // oxlint-disable-next-line typescript/no-require-imports
  const { DatabaseSync: DbCtor } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  const db = new DbCtor(dbPath);

  // Enable WAL for concurrent reads
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA_SQL);

  return new KnowledgeBase(db);
}

export class KnowledgeBase {
  // Prepared statements cached once for reuse on every call
  private readonly stmtStore;
  private readonly stmtRetrieve;
  private readonly stmtSearch;
  private readonly stmtStats;
  private readonly stmtListRecent;

  constructor(private readonly db: DatabaseSync) {
    this.stmtStore = db.prepare(
      `INSERT OR REPLACE INTO entries
       (ref_id, tool_name, tool_call_id, original_chars, compressed_chars, full_text, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtRetrieve = db.prepare("SELECT * FROM entries WHERE ref_id = ?");
    this.stmtSearch = db.prepare(
      `SELECT e.*
       FROM entries_fts f
       JOIN entries e ON e.rowid = f.rowid
       WHERE entries_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    );
    this.stmtStats = db.prepare(
      `SELECT
         COUNT(*) AS entry_count,
         COALESCE(SUM(original_chars), 0) AS total_original,
         COALESCE(SUM(compressed_chars), 0) AS total_compressed
       FROM entries`,
    );
    this.stmtListRecent = db.prepare(
      `SELECT ref_id, tool_name, tool_call_id, original_chars, compressed_chars, timestamp
       FROM entries ORDER BY timestamp DESC LIMIT ?`,
    );
  }

  /** Store a compressed entry. */
  store(entry: CompressedEntry): void {
    this.stmtStore.run(
      entry.refId,
      entry.toolName,
      entry.toolCallId,
      entry.originalChars,
      entry.compressedChars,
      entry.fullText,
      entry.timestamp,
    );
  }

  /** Retrieve a stored entry by reference ID. Returns null if not found. */
  retrieve(refId: string): CompressedEntry | null {
    const row = this.stmtRetrieve.get(refId) as EntryRow | undefined;

    if (!row) {
      return null;
    }
    return rowToEntry(row);
  }

  /**
   * Full-text search across stored entries.
   * Returns entries ranked by relevance, limited to `maxResults`.
   */
  search(query: string, maxResults = 10): CompressedEntry[] {
    if (!query.trim()) {
      return [];
    }

    // Escape FTS5 special characters for safe querying
    const safeQuery = escapeFts5Query(query);

    const rows = this.stmtSearch.all(safeQuery, maxResults) as EntryRow[];

    return rows.map(rowToEntry);
  }

  /** List recent entries (metadata only, no full text). */
  listRecent(limit = 20): RecentEntry[] {
    const rows = this.stmtListRecent.all(limit) as RecentEntryRow[];
    return rows.map((row) => ({
      refId: row.ref_id,
      toolName: row.tool_name,
      toolCallId: row.tool_call_id,
      originalChars: row.original_chars,
      compressedChars: row.compressed_chars,
      timestamp: row.timestamp,
    }));
  }

  /** Get basic stats about the knowledge base. */
  stats(): { entryCount: number; totalOriginalChars: number; totalCompressedChars: number } {
    const row = this.stmtStats.get() as {
      entry_count: number;
      total_original: number;
      total_compressed: number;
    };

    return {
      entryCount: row.entry_count,
      totalOriginalChars: row.total_original,
      totalCompressedChars: row.total_compressed,
    };
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

// -- Internal helpers --

type EntryRow = {
  ref_id: string;
  tool_name: string;
  tool_call_id: string;
  original_chars: number;
  compressed_chars: number;
  full_text: string;
  timestamp: number;
};

type RecentEntryRow = Omit<EntryRow, "full_text">;

function rowToEntry(row: EntryRow): CompressedEntry {
  return {
    refId: row.ref_id,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    originalChars: row.original_chars,
    compressedChars: row.compressed_chars,
    fullText: row.full_text,
    timestamp: row.timestamp,
  };
}

/** Escape special FTS5 query characters to prevent syntax errors. */
function escapeFts5Query(query: string): string {
  // Wrap each token in double quotes to treat as literal
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}
