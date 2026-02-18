/**
 * SQLite storage layer for DAEDALUS memory.
 *
 * All CRUD, trust transitions, search, staleness checks, and audit logging.
 * Uses Node 22 built-in `node:sqlite` via `createRequire` pattern.
 */

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { v4 as uuidv4 } from "uuid";

import {
  type TrustLevel,
  type Origin,
  type TransitionTrigger,
  isValidTransition,
  isValidTransitionWithTrigger,
  assertAICannotWriteBlue,
  defaultTrustForOrigin,
} from "./trust.js";

const require = createRequire(import.meta.url);

function requireNodeSqlite(): typeof import("node:sqlite") {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Fact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  fact_text: string;
  trust_level: TrustLevel;
  origin: Origin;
  source_agent: string | null;
  created_at: string;
  updated_at: string;
  validated_at: string | null;
  expires_at: string | null;
  validator_notes: string | null;
  session_id: string | null;
}

export interface FactInput {
  subject: string;
  predicate: string;
  object: string;
  fact_text: string;
  origin: Origin;
  source_agent?: string;
  expires_at?: string;
  session_id?: string;
}

export interface TrustTransition {
  id: string;
  fact_id: string;
  from_trust: TrustLevel;
  to_trust: TrustLevel;
  trigger: TransitionTrigger;
  actor: string;
  timestamp: string;
  notes: string | null;
}

export interface SearchOptions {
  limit?: number;
  trust_levels?: TrustLevel[];
}

export interface SearchResult {
  fact: Fact;
  score: number;
}

export interface DbStats {
  total: number;
  blue: number;
  green: number;
  red: number;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,
  predicate       TEXT NOT NULL,
  object          TEXT NOT NULL,
  fact_text       TEXT NOT NULL,
  trust_level     TEXT NOT NULL CHECK(trust_level IN ('blue', 'green', 'red')),
  origin          TEXT NOT NULL CHECK(origin IN ('user', 'ai_suggested')),
  source_agent    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  validated_at    TEXT,
  expires_at      TEXT,
  validator_notes TEXT,
  session_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_trust_level ON facts(trust_level);
CREATE INDEX IF NOT EXISTS idx_created_at  ON facts(created_at);
CREATE INDEX IF NOT EXISTS idx_subject     ON facts(subject);

CREATE TABLE IF NOT EXISTS trust_transitions (
  id         TEXT PRIMARY KEY,
  fact_id    TEXT NOT NULL REFERENCES facts(id),
  from_trust TEXT NOT NULL,
  to_trust   TEXT NOT NULL,
  trigger    TEXT NOT NULL,
  actor      TEXT NOT NULL,
  timestamp  TEXT NOT NULL,
  notes      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tt_fact_id ON trust_transitions(fact_id);
`;

// ---------------------------------------------------------------------------
// Trust-level sort priority for search results (lower = higher priority)
// ---------------------------------------------------------------------------

const TRUST_PRIORITY: Record<TrustLevel, number> = {
  blue: 0,
  green: 1,
  red: 2,
};

// ---------------------------------------------------------------------------
// DaedalusDb class
// ---------------------------------------------------------------------------

export class DaedalusDb {
  private db: DatabaseSync;

  /** Opens (or creates) the SQLite database at `dbPath` and runs migrations. */
  constructor(dbPath: string) {
    const { DatabaseSync: DbSync } = requireNodeSqlite();
    this.db = new DbSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
  }

  // -----------------------------------------------------------------------
  // Write operations
  // -----------------------------------------------------------------------

  /** Inserts a new fact and records the initial trust transition. */
  writeFact(input: FactInput): Fact {
    const trustLevel = defaultTrustForOrigin(input.origin);
    assertAICannotWriteBlue(input.origin, trustLevel);

    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO facts (id, subject, predicate, object, fact_text, trust_level, origin,
                         source_agent, created_at, updated_at, validated_at, expires_at,
                         validator_notes, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.subject,
      input.predicate,
      input.object,
      input.fact_text,
      trustLevel,
      input.origin,
      input.source_agent ?? null,
      now,
      now,
      input.origin === "user" ? now : null,
      input.expires_at ?? null,
      null,
      input.session_id ?? null,
    );

    this.recordTransition({
      fact_id: id,
      from_trust: trustLevel,
      to_trust: trustLevel,
      trigger: "initial_write",
      actor: input.origin === "user" ? "user" : (input.source_agent ?? "system"),
      notes: null,
    });

    return this.getFact(id)!;
  }

  private recordTransition(params: {
    fact_id: string;
    from_trust: TrustLevel;
    to_trust: TrustLevel;
    trigger: TransitionTrigger;
    actor: string;
    notes: string | null;
  }): void {
    const id = uuidv4();
    const timestamp = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO trust_transitions (id, fact_id, from_trust, to_trust, trigger, actor, timestamp, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      params.fact_id,
      params.from_trust,
      params.to_trust,
      params.trigger,
      params.actor,
      timestamp,
      params.notes,
    );
  }

  // -----------------------------------------------------------------------
  // Read operations
  // -----------------------------------------------------------------------

  /** Returns a single fact by ID, or `null` if not found. */
  getFact(id: string): Fact | null {
    const stmt = this.db.prepare("SELECT * FROM facts WHERE id = ?");
    const row = stmt.get(id) as unknown as Fact | undefined;
    return row ?? null;
  }

  /** Returns AI-suggested facts awaiting human review, oldest first. */
  listPending(limit: number = 50): Fact[] {
    const stmt = this.db.prepare(
      "SELECT * FROM facts WHERE trust_level = 'green' ORDER BY created_at ASC LIMIT ?",
    );
    return stmt.all(limit) as unknown as Fact[];
  }

  /** Returns non-red facts matching an exact (subject, predicate, object) triple. */
  findExactTriple(subject: string, predicate: string, object: string): Fact[] {
    const stmt = this.db.prepare(
      "SELECT * FROM facts WHERE subject = ? AND predicate = ? AND object = ? AND trust_level != 'red'",
    );
    return stmt.all(subject, predicate, object) as unknown as Fact[];
  }

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  /** Searches facts by keyword relevance, excluding red facts by default. */
  searchFacts(query: string, options?: SearchOptions): SearchResult[] {
    const trustLevels = options?.trust_levels ?? ["blue", "green"] as TrustLevel[];
    const limit = options?.limit ?? 5;
    return this.scoredSearch(query, trustLevels, limit);
  }

  // FTS5 upgrade: replace scoredSearch() with a virtual table query once
  // target environment confirms FTS5 support. Schema addition needed:
  // CREATE VIRTUAL TABLE facts_fts USING fts5(fact_text, subject, predicate, object);
  // + INSERT/UPDATE/DELETE triggers to keep it in sync.
  private scoredSearch(query: string, trustLevels: TrustLevel[], limit: number): SearchResult[] {
    const placeholders = trustLevels.map(() => "?").join(", ");
    const sql = `SELECT * FROM facts WHERE trust_level IN (${placeholders})`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...trustLevels) as unknown as Fact[];

    const keywords = [...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    )];

    const scored: SearchResult[] = [];

    for (const fact of rows) {
      let score = 0;
      const textLower = fact.fact_text.toLowerCase();
      const subjectLower = fact.subject.toLowerCase();
      const objectLower = fact.object.toLowerCase();
      const predicateLower = fact.predicate.toLowerCase();

      for (const kw of keywords) {
        if (textLower.includes(kw)) score += 3;
        if (subjectLower.includes(kw)) score += 2;
        if (objectLower.includes(kw)) score += 2;
        if (predicateLower.includes(kw)) score += 1;
      }

      if (score > 0) {
        scored.push({ fact, score });
      }
    }

    scored.sort((a, b) => {
      const trustDiff = TRUST_PRIORITY[a.fact.trust_level] - TRUST_PRIORITY[b.fact.trust_level];
      if (trustDiff !== 0) return trustDiff;
      if (b.score !== a.score) return b.score - a.score;
      return b.fact.updated_at.localeCompare(a.fact.updated_at);
    });

    return scored.slice(0, limit);
  }

  // -----------------------------------------------------------------------
  // Trust transitions
  // -----------------------------------------------------------------------

  /** Transitions a fact to a new trust level, validating the transition and trigger. */
  updateTrustLevel(
    id: string,
    to: TrustLevel,
    trigger: TransitionTrigger,
    actor: string,
    notes?: string,
  ): Fact {
    const fact = this.getFact(id);
    if (!fact) {
      throw new Error(`updateTrustLevel failed: fact '${id}' not found`);
    }

    if (!isValidTransition(fact.trust_level, to)) {
      throw new Error(
        `updateTrustLevel failed: transition '${fact.trust_level} → ${to}' is not allowed for fact '${id}'`,
      );
    }

    if (!isValidTransitionWithTrigger(fact.trust_level, to, trigger)) {
      throw new Error(
        `updateTrustLevel failed: trigger '${trigger}' is not valid for transition '${fact.trust_level} → ${to}' on fact '${id}'`,
      );
    }

    const now = new Date().toISOString();

    if (to === "blue") {
      const stmt = this.db.prepare(
        "UPDATE facts SET trust_level = ?, updated_at = ?, validated_at = ? WHERE id = ?",
      );
      stmt.run(to, now, now, id);
    } else {
      const stmt = this.db.prepare(
        "UPDATE facts SET trust_level = ?, updated_at = ? WHERE id = ?",
      );
      stmt.run(to, now, id);
    }

    this.recordTransition({
      fact_id: id,
      from_trust: fact.trust_level,
      to_trust: to,
      trigger,
      actor,
      notes: notes ?? null,
    });

    return this.getFact(id)!;
  }

  /** Returns the full trust transition history for a fact, oldest first. */
  getTransitionHistory(factId: string): TrustTransition[] {
    const stmt = this.db.prepare(
      "SELECT * FROM trust_transitions WHERE fact_id = ? ORDER BY timestamp ASC",
    );
    return stmt.all(factId) as unknown as TrustTransition[];
  }

  // -----------------------------------------------------------------------
  // Staleness
  // -----------------------------------------------------------------------

  /** Demotes stale green facts to red. Returns the number of facts demoted. */
  runStalenessCheck(staleDays: number = 7): number {
    const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();

    const stmt = this.db.prepare(
      "SELECT * FROM facts WHERE trust_level = 'green' AND created_at < ?",
    );
    const staleFacts = stmt.all(cutoff) as unknown as Fact[];

    for (const fact of staleFacts) {
      this.updateTrustLevel(
        fact.id,
        "red",
        "staleness_timeout",
        "system",
        `Stale: exceeded ${staleDays} day review window`,
      );
    }

    return staleFacts.length;
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  /** Returns counts of facts grouped by trust level. */
  getStats(): DbStats {
    const stmt = this.db.prepare(
      "SELECT trust_level, COUNT(*) as count FROM facts GROUP BY trust_level",
    );
    const rows = stmt.all() as unknown as Array<{ trust_level: TrustLevel; count: number }>;

    const stats: DbStats = { total: 0, blue: 0, green: 0, red: 0 };
    for (const row of rows) {
      stats[row.trust_level] = row.count;
      stats.total += row.count;
    }
    return stats;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Closes the database connection. */
  close(): void {
    this.db.close();
  }
}

/** Creates and returns a new DaedalusDb instance. */
export function createDaedalusDb(dbPath: string): DaedalusDb {
  return new DaedalusDb(dbPath);
}
