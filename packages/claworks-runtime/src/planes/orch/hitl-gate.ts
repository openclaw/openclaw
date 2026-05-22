import { randomUUID } from "node:crypto";
import type { CwDatabase } from "../data/db.js";
import type { PlaybookRun } from "./playbook-types.js";

export interface HitlPending {
  token: string;
  runId: string;
  stepId: string;
  message: string;
  options: string[];
  createdAt: Date;
  /** Unix ms when this entry expires; undefined = no timeout. */
  expiresAt?: number;
  /** Auto-resolve decision when expired; undefined means abort the run. */
  onTimeout?: string;
}

export interface ExpiredHitl {
  pending: HitlPending;
  /** Auto-resolution decision (onTimeout value or first option). */
  decision: string;
}

export interface HitlGate {
  suspend(
    run: PlaybookRun,
    stepId: string,
    message: string,
    options: string[],
    timeoutSeconds?: number,
    onTimeout?: string,
  ): string;
  resolve(token: string, decision: string, comment?: string): HitlPending | null;
  get(token: string): HitlPending | undefined;
  /** List all currently pending approvals (for REST /v1/hitl/pending). */
  listPending(): HitlPending[];
  /**
   * Scan for entries past their expiresAt deadline.
   * Removes them and returns their auto-resolution info for the caller to handle.
   * Call from a scheduler tick (e.g., every 30 s).
   */
  expireStale(): ExpiredHitl[];
  /** Hydrate in-memory state from DB after process restart. */
  hydrate?(): void;
}

// ── In-memory gate (tests / standalone no-DB mode) ──────────────────────

export function createHitlGate(): HitlGate {
  const pending = new Map<string, HitlPending>();

  return {
    suspend(run, stepId, message, options, timeoutSeconds, onTimeout) {
      const token = randomUUID();
      const entry: HitlPending = {
        token,
        runId: run.id,
        stepId,
        message,
        options,
        createdAt: new Date(),
        expiresAt: timeoutSeconds ? Date.now() + timeoutSeconds * 1000 : undefined,
        onTimeout,
      };
      pending.set(token, entry);
      return token;
    },

    resolve(token, _decision, _comment) {
      const entry = pending.get(token);
      if (!entry) {
        return null;
      }
      pending.delete(token);
      return entry;
    },

    get(token) {
      return pending.get(token);
    },

    listPending() {
      return [...pending.values()];
    },

    expireStale() {
      const now = Date.now();
      const expired: ExpiredHitl[] = [];
      for (const [token, entry] of pending) {
        if (entry.expiresAt !== undefined && now >= entry.expiresAt) {
          pending.delete(token);
          expired.push({
            pending: entry,
            decision: entry.onTimeout ?? entry.options[0] ?? "approve",
          });
        }
      }
      return expired;
    },
  };
}

// ── DB-backed gate (production with SQLite) ──────────────────────────────

type HitlRow = {
  token: string;
  run_id: string;
  step_id: string;
  message: string;
  options: string;
  created_at: number;
  expires_at: number | null;
  on_timeout: string | null;
};

function rowToPending(row: HitlRow): HitlPending {
  return {
    token: row.token,
    runId: row.run_id,
    stepId: row.step_id,
    message: row.message,
    options: JSON.parse(row.options) as string[],
    createdAt: new Date(row.created_at),
    expiresAt: row.expires_at ?? undefined,
    onTimeout: row.on_timeout ?? undefined,
  };
}

export function createDbHitlGate(db: CwDatabase): HitlGate {
  const cache = new Map<string, HitlPending>();

  // Ensure the extended columns exist (idempotent migration)
  db.exec(
    `CREATE TABLE IF NOT EXISTS cw_hitl_pending (
      token TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      message TEXT NOT NULL,
      options TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      on_timeout TEXT
    )`,
  );
  // Add new columns if upgrading from older schema
  try {
    db.exec("ALTER TABLE cw_hitl_pending ADD COLUMN expires_at INTEGER");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE cw_hitl_pending ADD COLUMN on_timeout TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE cw_hitl_pending ADD COLUMN token TEXT");
  } catch {
    /* already exists */
  }

  const insert = db.prepare(`
    INSERT INTO cw_hitl_pending (token, run_id, step_id, message, options, created_at, expires_at, on_timeout)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token) DO NOTHING
  `);
  const del = db.prepare("DELETE FROM cw_hitl_pending WHERE token = ?");
  const selectOne = db.prepare("SELECT * FROM cw_hitl_pending WHERE token = ?");
  const selectAll = db.prepare("SELECT * FROM cw_hitl_pending ORDER BY created_at ASC");
  const selectExpired = db.prepare(
    "SELECT * FROM cw_hitl_pending WHERE expires_at IS NOT NULL AND expires_at <= ?",
  );
  const deleteExpired = db.prepare(
    "DELETE FROM cw_hitl_pending WHERE expires_at IS NOT NULL AND expires_at <= ?",
  );

  return {
    suspend(run, stepId, message, options, timeoutSeconds, onTimeout) {
      const token = randomUUID();
      const now = Date.now();
      const expiresAt = timeoutSeconds ? now + timeoutSeconds * 1000 : null;
      const entry: HitlPending = {
        token,
        runId: run.id,
        stepId,
        message,
        options,
        createdAt: new Date(now),
        expiresAt: expiresAt ?? undefined,
        onTimeout,
      };
      insert.run(
        token,
        run.id,
        stepId,
        message,
        JSON.stringify(options),
        now,
        expiresAt,
        onTimeout ?? null,
      );
      cache.set(token, entry);
      return token;
    },

    resolve(token, _decision, _comment) {
      const entry =
        cache.get(token) ??
        (() => {
          const row = selectOne.get(token) as HitlRow | undefined;
          return row ? rowToPending(row) : undefined;
        })();
      if (!entry) {
        return null;
      }
      del.run(token);
      cache.delete(token);
      return entry;
    },

    get(token) {
      if (cache.has(token)) {
        return cache.get(token);
      }
      const row = selectOne.get(token) as HitlRow | undefined;
      if (!row) {
        return undefined;
      }
      const entry = rowToPending(row);
      cache.set(token, entry);
      return entry;
    },

    listPending() {
      const rows = selectAll.all() as HitlRow[];
      return rows.map(rowToPending);
    },

    expireStale() {
      const now = Date.now();
      const rows = selectExpired.all(now) as HitlRow[];
      if (rows.length === 0) {
        return [];
      }
      deleteExpired.run(now);
      for (const row of rows) {
        cache.delete(row.token);
      }
      return rows.map((row) => {
        const p = rowToPending(row);
        return {
          pending: p,
          decision: p.onTimeout ?? p.options[0] ?? "approve",
        };
      });
    },

    hydrate() {
      const rows = selectAll.all() as HitlRow[];
      for (const row of rows) {
        cache.set(row.token, rowToPending(row));
      }
    },
  };
}
