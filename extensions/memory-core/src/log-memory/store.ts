import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { bm25RankToScore, buildFtsQuery } from "../memory/hybrid.js";
import { closeMemoryDatabase, openMemoryDatabaseAtPath } from "../memory/manager-db.js";
import { computeCurrentDecay } from "./decay.js";
import type { DreamRecord, LogMemoryEntry, LogMemoryLayer, LogMemoryPayload } from "./types.js";

// Stored in a sibling SQLite database under the agent workspace. Keeping it
// off the main memory db avoids schema/dirty-flag interference with the
// existing MemoryIndexManager and keeps dream-cycle bulk deletes contained.
const DEFAULT_DB_FILENAME = "log-memory.db";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS log_memory_entries (
  id TEXT PRIMARY KEY,
  timestamp_ms INTEGER NOT NULL,
  layer TEXT NOT NULL CHECK(layer IN ('episodic','semantic','procedural')),
  payload_type TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL,
  source TEXT NOT NULL,
  decay_score REAL NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_ms INTEGER NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_log_memory_layer_decay
  ON log_memory_entries(layer, decay_score);
CREATE INDEX IF NOT EXISTS idx_log_memory_layer_ts
  ON log_memory_entries(layer, timestamp_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS log_memory_fts USING fts5(
  content,
  tags,
  content='log_memory_entries',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS log_memory_ai
  AFTER INSERT ON log_memory_entries BEGIN
  INSERT INTO log_memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS log_memory_ad
  AFTER DELETE ON log_memory_entries BEGIN
  INSERT INTO log_memory_fts(log_memory_fts, rowid, content, tags)
    VALUES('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS log_memory_au
  AFTER UPDATE ON log_memory_entries BEGIN
  INSERT INTO log_memory_fts(log_memory_fts, rowid, content, tags)
    VALUES('delete', old.rowid, old.content, old.tags);
  INSERT INTO log_memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS dream_records (
  dream_id TEXT PRIMARY KEY,
  triggered_at_ms INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  episodic_consumed INTEGER NOT NULL,
  semantic_produced INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
`;

type Row = {
  id: string;
  timestamp_ms: number;
  layer: LogMemoryLayer;
  payload_type: LogMemoryPayload["type"];
  content: string;
  tags: string;
  source: LogMemoryPayload["source"];
  decay_score: number;
  access_count: number;
  last_accessed_ms: number;
  embedding: Uint8Array | null;
};

export type LogMemoryHybridResult = {
  entry: LogMemoryEntry;
  score: number;
  vectorScore: number;
  bm25Score: number;
};

export interface UpsertInput {
  id: string;
  timestamp: Date;
  layer: LogMemoryLayer;
  embedding?: Float32Array;
  payload: LogMemoryPayload;
}

export class LogMemoryStore {
  private readonly db: DatabaseSync;
  private closed = false;

  static resolveDbPath(workspaceDir: string): string {
    return path.join(workspaceDir, ".openclaw", DEFAULT_DB_FILENAME);
  }

  constructor(opts: { workspaceDir: string; dbPath?: string }) {
    const dbPath = opts.dbPath ?? LogMemoryStore.resolveDbPath(opts.workspaceDir);
    this.db = openMemoryDatabaseAtPath(dbPath, false);
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    closeMemoryDatabase(this.db);
  }

  has(id: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS found FROM log_memory_entries WHERE id = ?`)
      .get(id) as { found?: number } | undefined;
    return row?.found === 1;
  }

  upsert(entry: UpsertInput): void {
    const stmt = this.db.prepare(
      `INSERT INTO log_memory_entries(
         id, timestamp_ms, layer, payload_type, content, tags, source,
         decay_score, access_count, last_accessed_ms, embedding
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         timestamp_ms = excluded.timestamp_ms,
         layer = excluded.layer,
         payload_type = excluded.payload_type,
         content = excluded.content,
         tags = excluded.tags,
         source = excluded.source,
         decay_score = excluded.decay_score,
         access_count = excluded.access_count,
         last_accessed_ms = excluded.last_accessed_ms,
         embedding = excluded.embedding`,
    );
    stmt.run(
      entry.id,
      entry.timestamp.getTime(),
      entry.layer,
      entry.payload.type,
      entry.payload.content,
      JSON.stringify(entry.payload.tags),
      entry.payload.source,
      entry.payload.decayScore,
      entry.payload.accessCount,
      entry.payload.lastAccessedAt.getTime(),
      entry.embedding ? embeddingToBuffer(entry.embedding) : null,
    );
  }

  delete(ids: string[]): number {
    if (ids.length === 0) {
      return 0;
    }
    let deleted = 0;
    const stmt = this.db.prepare(`DELETE FROM log_memory_entries WHERE id = ?`);
    for (const id of ids) {
      const result = stmt.run(id);
      deleted += Number(result.changes ?? 0);
    }
    return deleted;
  }

  countByLayer(layer: LogMemoryLayer): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM log_memory_entries WHERE layer = ?`)
      .get(layer) as { c: number };
    return row.c;
  }

  listByLayer(layer: LogMemoryLayer, limit = 1000): LogMemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM log_memory_entries WHERE layer = ? ORDER BY timestamp_ms DESC LIMIT ?`,
      )
      .all(layer, limit) as Row[];
    return rows.map(rowToEntry);
  }

  // Returns episodic candidates whose dynamic decay (recomputed from age,
  // access count, and importance) is below the threshold.
  selectDreamCandidates(opts: { threshold: number; limit: number; now: Date }): LogMemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM log_memory_entries
         WHERE layer = 'episodic'
         ORDER BY decay_score ASC, timestamp_ms ASC
         LIMIT ?`,
      )
      .all(Math.max(opts.limit * 2, opts.limit)) as Row[];
    const entries = rows.map(rowToEntry);
    return entries
      .filter((entry) => computeCurrentDecay(entry, opts.now) < opts.threshold)
      .slice(0, opts.limit);
  }

  recordAccess(id: string, now: Date): void {
    this.db
      .prepare(
        `UPDATE log_memory_entries
           SET access_count = access_count + 1, last_accessed_ms = ?
           WHERE id = ?`,
      )
      .run(now.getTime(), id);
  }

  insertDreamRecord(record: DreamRecord): void {
    this.db
      .prepare(
        `INSERT INTO dream_records(
           dream_id, triggered_at_ms, trigger, episodic_consumed,
           semantic_produced, duration_ms
         ) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        record.dreamId,
        record.triggeredAt.getTime(),
        record.trigger,
        record.episodicConsumed,
        record.semanticProduced,
        record.durationMs,
      );
  }

  listDreamRecords(limit = 50): DreamRecord[] {
    const rows = this.db
      .prepare(
        `SELECT dream_id, triggered_at_ms, trigger, episodic_consumed,
                semantic_produced, duration_ms
         FROM dream_records ORDER BY triggered_at_ms DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      dream_id: string;
      triggered_at_ms: number;
      trigger: DreamRecord["trigger"];
      episodic_consumed: number;
      semantic_produced: number;
      duration_ms: number;
    }>;
    return rows.map((r) => ({
      dreamId: r.dream_id,
      triggeredAt: new Date(r.triggered_at_ms),
      trigger: r.trigger,
      episodicConsumed: r.episodic_consumed,
      semanticProduced: r.semantic_produced,
      durationMs: r.duration_ms,
    }));
  }

  // Hybrid retrieval: cosine over embeddings + BM25 over FTS5, merged via
  // 0.6 * vector + 0.4 * bm25, top-K. Either side may be empty.
  async hybridSearch(opts: {
    queryText: string;
    queryEmbedding?: Float32Array;
    layer?: LogMemoryLayer;
    tags?: string[];
    limit?: number;
  }): Promise<LogMemoryHybridResult[]> {
    const limit = Math.max(1, opts.limit ?? 10);
    const candidates = limit * 5;

    const bm25Hits = this.searchBm25({
      queryText: opts.queryText,
      layer: opts.layer,
      tags: opts.tags,
      limit: candidates,
    });

    const vectorHits = opts.queryEmbedding
      ? this.searchVector({
          queryEmbedding: opts.queryEmbedding,
          layer: opts.layer,
          tags: opts.tags,
          limit: candidates,
        })
      : [];

    const merged = new Map<string, { entry: LogMemoryEntry; vector: number; bm25: number }>();
    for (const hit of bm25Hits) {
      merged.set(hit.entry.id, { entry: hit.entry, vector: 0, bm25: hit.score });
    }
    for (const hit of vectorHits) {
      const existing = merged.get(hit.entry.id);
      if (existing) {
        existing.vector = hit.score;
      } else {
        merged.set(hit.entry.id, { entry: hit.entry, vector: hit.score, bm25: 0 });
      }
    }

    const results: LogMemoryHybridResult[] = [];
    for (const value of merged.values()) {
      const score = 0.6 * value.vector + 0.4 * value.bm25;
      results.push({
        entry: value.entry,
        score,
        vectorScore: value.vector,
        bm25Score: value.bm25,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private searchBm25(opts: {
    queryText: string;
    layer?: LogMemoryLayer;
    tags?: string[];
    limit: number;
  }): Array<{ entry: LogMemoryEntry; score: number }> {
    const ftsQuery = buildFtsQuery(opts.queryText);
    if (!ftsQuery) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT e.*, bm25(log_memory_fts) AS rank
         FROM log_memory_fts
         JOIN log_memory_entries e ON e.rowid = log_memory_fts.rowid
         WHERE log_memory_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, opts.limit) as Array<Row & { rank: number }>;
    return rows
      .map((row) => ({ entry: rowToEntry(row), score: bm25RankToScore(row.rank) }))
      .filter((item) => matchesFilters(item.entry, opts));
  }

  private searchVector(opts: {
    queryEmbedding: Float32Array;
    layer?: LogMemoryLayer;
    tags?: string[];
    limit: number;
  }): Array<{ entry: LogMemoryEntry; score: number }> {
    const rows = this.db
      .prepare(`SELECT * FROM log_memory_entries WHERE embedding IS NOT NULL`)
      .all() as Row[];
    const queryNorm = vectorNorm(opts.queryEmbedding);
    if (queryNorm === 0) {
      return [];
    }
    const scored: Array<{ entry: LogMemoryEntry; score: number }> = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (!entry.embedding || !matchesFilters(entry, opts)) {
        continue;
      }
      const sim = cosineSimilarity(opts.queryEmbedding, entry.embedding, queryNorm);
      if (sim <= 0) {
        continue;
      }
      scored.push({ entry, score: sim });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit);
  }
}

function matchesFilters(
  entry: LogMemoryEntry,
  opts: { layer?: LogMemoryLayer; tags?: string[] },
): boolean {
  if (opts.layer && entry.layer !== opts.layer) {
    return false;
  }
  if (opts.tags && opts.tags.length > 0) {
    const tagSet = new Set(entry.payload.tags);
    if (!opts.tags.every((tag) => tagSet.has(tag))) {
      return false;
    }
  }
  return true;
}

export function rowToEntry(row: Row): LogMemoryEntry {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp_ms),
    layer: row.layer,
    embedding: row.embedding ? bufferToEmbedding(row.embedding) : undefined,
    payload: {
      type: row.payload_type,
      content: row.content,
      tags: parseTags(row.tags),
      source: row.source,
      decayScore: row.decay_score,
      accessCount: row.access_count,
      lastAccessedAt: new Date(row.last_accessed_ms),
    },
  };
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function embeddingToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToEmbedding(buf: Uint8Array): Float32Array {
  // Copy so the underlying SQLite buffer is not retained.
  const view = new Float32Array(buf.byteLength / 4);
  const src = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < view.length; i++) {
    view[i] = src.getFloat32(i * 4, true);
  }
  return view;
}

export function vectorNorm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array, normA?: number): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let bSum = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    bSum += b[i] * b[i];
  }
  const aNorm = normA ?? vectorNorm(a);
  const bNorm = Math.sqrt(bSum);
  if (aNorm === 0 || bNorm === 0) {
    return 0;
  }
  return dot / (aNorm * bNorm);
}
