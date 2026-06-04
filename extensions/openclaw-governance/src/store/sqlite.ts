// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.
//
// Local SQLite-backed governance store. Inspired by Nexus's MongoDB-backed
// equivalents (data_transmissions, aibom_records, cost ledger collections);
// this port targets node:sqlite for a single-node, on-disk personal store.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AibomRow = {
  id: string;
  runId: string;
  sessionKey: string;
  provider: string;
  modelId: string;
  channelId: string | null;
  skillId: string | null;
  recordJson: string;
  signature: string;
  generatedAt: string;
  createdAtMs: number;
};

export type DlpFindingRow = {
  id: string;
  runId: string;
  sessionKey: string;
  channelId: string | null;
  direction: "outbound" | "inbound";
  entityType: string;
  detector: string;
  start: number;
  end: number;
  score: number;
  matchedSnippet: string;
  action: "log" | "warn" | "redact" | "block";
  createdAtMs: number;
};

export type CostEntryRow = {
  id: string;
  runId: string;
  sessionKey: string;
  provider: string;
  modelId: string;
  channelId: string | null;
  skillId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  source: "provider" | "estimate";
  startedAtMs: number;
  endedAtMs: number;
  createdAtMs: number;
};

type DatabaseSyncCtor = new (path: string, opts?: { readOnly?: boolean }) => DatabaseSyncLike;

type DatabaseSyncLike = {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
};

type StatementLike = {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
};

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER PRIMARY KEY,
     applied_at_ms INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS aibom_records (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     session_key TEXT NOT NULL,
     provider TEXT NOT NULL,
     model_id TEXT NOT NULL,
     channel_id TEXT,
     skill_id TEXT,
     record_json TEXT NOT NULL,
     signature TEXT NOT NULL,
     generated_at TEXT NOT NULL,
     created_at_ms INTEGER NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS aibom_records_run_id_idx ON aibom_records(run_id);`,
  `CREATE INDEX IF NOT EXISTS aibom_records_session_key_idx ON aibom_records(session_key);`,
  `CREATE INDEX IF NOT EXISTS aibom_records_created_at_ms_idx ON aibom_records(created_at_ms);`,
  `CREATE TABLE IF NOT EXISTS dlp_findings (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     session_key TEXT NOT NULL,
     channel_id TEXT,
     direction TEXT NOT NULL,
     entity_type TEXT NOT NULL,
     detector TEXT NOT NULL,
     start_offset INTEGER NOT NULL,
     end_offset INTEGER NOT NULL,
     score REAL NOT NULL,
     matched_snippet TEXT NOT NULL,
     action TEXT NOT NULL,
     created_at_ms INTEGER NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS dlp_findings_run_id_idx ON dlp_findings(run_id);`,
  `CREATE INDEX IF NOT EXISTS dlp_findings_entity_type_idx ON dlp_findings(entity_type);`,
  `CREATE TABLE IF NOT EXISTS cost_entries (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     session_key TEXT NOT NULL,
     provider TEXT NOT NULL,
     model_id TEXT NOT NULL,
     channel_id TEXT,
     skill_id TEXT,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     total_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0,
     source TEXT NOT NULL,
     started_at_ms INTEGER NOT NULL,
     ended_at_ms INTEGER NOT NULL,
     created_at_ms INTEGER NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS cost_entries_run_id_idx ON cost_entries(run_id);`,
  `CREATE INDEX IF NOT EXISTS cost_entries_session_key_idx ON cost_entries(session_key);`,
  `CREATE INDEX IF NOT EXISTS cost_entries_skill_id_idx ON cost_entries(skill_id);`,
  `CREATE INDEX IF NOT EXISTS cost_entries_channel_id_idx ON cost_entries(channel_id);`,
  `CREATE INDEX IF NOT EXISTS cost_entries_ended_at_ms_idx ON cost_entries(ended_at_ms);`,
];

async function loadDatabaseSync(): Promise<DatabaseSyncCtor> {
  const sqliteModule = (await import("node:sqlite")) as {
    DatabaseSync: DatabaseSyncCtor;
  };
  return sqliteModule.DatabaseSync;
}

export type GovernanceStoreOptions = {
  dbPath: string;
};

export class GovernanceStore {
  private constructor(private readonly db: DatabaseSyncLike) {}

  static async open(opts: GovernanceStoreOptions): Promise<GovernanceStore> {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    const DatabaseSync = await loadDatabaseSync();
    const db = new DatabaseSync(opts.dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    for (const stmt of MIGRATIONS) {
      db.exec(stmt);
    }
    const versionRow = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
      | { v: number | null }
      | undefined;
    if (!versionRow || versionRow.v === null) {
      db.prepare("INSERT INTO schema_version(version, applied_at_ms) VALUES(?, ?)").run(
        1,
        Date.now(),
      );
    }
    return new GovernanceStore(db);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* swallow */
    }
  }

  insertAibom(row: AibomRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO aibom_records
         (id, run_id, session_key, provider, model_id, channel_id, skill_id,
          record_json, signature, generated_at, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.runId,
        row.sessionKey,
        row.provider,
        row.modelId,
        row.channelId,
        row.skillId,
        row.recordJson,
        row.signature,
        row.generatedAt,
        row.createdAtMs,
      );
  }

  listAibomByRun(runId: string): AibomRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id AS runId, session_key AS sessionKey, provider, model_id AS modelId,
                channel_id AS channelId, skill_id AS skillId, record_json AS recordJson,
                signature, generated_at AS generatedAt, created_at_ms AS createdAtMs
         FROM aibom_records WHERE run_id = ? ORDER BY created_at_ms ASC`,
      )
      .all(runId);
    return rows as AibomRow[];
  }

  insertDlpFinding(row: DlpFindingRow): void {
    this.db
      .prepare(
        `INSERT INTO dlp_findings
         (id, run_id, session_key, channel_id, direction, entity_type, detector,
          start_offset, end_offset, score, matched_snippet, action, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.runId,
        row.sessionKey,
        row.channelId,
        row.direction,
        row.entityType,
        row.detector,
        row.start,
        row.end,
        row.score,
        row.matchedSnippet,
        row.action,
        row.createdAtMs,
      );
  }

  listDlpFindingsByRun(runId: string): DlpFindingRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id AS runId, session_key AS sessionKey, channel_id AS channelId,
                direction, entity_type AS entityType, detector,
                start_offset AS start, end_offset AS end, score,
                matched_snippet AS matchedSnippet, action, created_at_ms AS createdAtMs
         FROM dlp_findings WHERE run_id = ? ORDER BY created_at_ms ASC`,
      )
      .all(runId);
    return rows as DlpFindingRow[];
  }

  insertCostEntry(row: CostEntryRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cost_entries
         (id, run_id, session_key, provider, model_id, channel_id, skill_id,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          total_tokens, cost_usd, source, started_at_ms, ended_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.runId,
        row.sessionKey,
        row.provider,
        row.modelId,
        row.channelId,
        row.skillId,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.totalTokens,
        row.costUsd,
        row.source,
        row.startedAtMs,
        row.endedAtMs,
        row.createdAtMs,
      );
  }

  listCostEntries(filter: {
    fromMs?: number;
    toMs?: number;
  }): CostEntryRow[] {
    const fromMs = filter.fromMs ?? 0;
    const toMs = filter.toMs ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        `SELECT id, run_id AS runId, session_key AS sessionKey, provider, model_id AS modelId,
                channel_id AS channelId, skill_id AS skillId,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
                total_tokens AS totalTokens, cost_usd AS costUsd, source,
                started_at_ms AS startedAtMs, ended_at_ms AS endedAtMs,
                created_at_ms AS createdAtMs
         FROM cost_entries WHERE ended_at_ms >= ? AND ended_at_ms <= ? ORDER BY ended_at_ms ASC`,
      )
      .all(fromMs, toMs);
    return rows as CostEntryRow[];
  }
}
