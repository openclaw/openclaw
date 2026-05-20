import { randomUUID } from "node:crypto";
import type { CwDatabase } from "../planes/data/db-types.js";

export type OutboxDelivery = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastError?: string;
};

export type EventOutbox = {
  enqueue(kind: string, payload: Record<string, unknown>): string;
  flush(
    handler: (delivery: OutboxDelivery) => Promise<void>,
    opts?: { onExhausted?: (delivery: OutboxDelivery) => Promise<void> },
  ): Promise<number>;
  pendingCount(): number;
  deadCount(): number;
};

export function createEventOutbox(db: CwDatabase): EventOutbox {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cw_outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      is_dead INTEGER NOT NULL DEFAULT 0
    );
  `);

  const insert = db.prepare(`
    INSERT INTO cw_outbox (id, kind, payload, attempts, max_attempts, next_attempt_at, created_at, is_dead)
    VALUES (?, ?, ?, 0, ?, ?, ?, 0)
  `);
  const selectDue = db.prepare(`
    SELECT * FROM cw_outbox
    WHERE is_dead = 0 AND next_attempt_at <= ?
    ORDER BY next_attempt_at ASC
    LIMIT ?
  `);
  const updateAttempt = db.prepare(`
    UPDATE cw_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?
  `);
  const markDead = db.prepare(`
    UPDATE cw_outbox SET is_dead = 1, attempts = ?, last_error = ? WHERE id = ?
  `);
  const deleteRow = db.prepare(`DELETE FROM cw_outbox WHERE id = ?`);

  return {
    enqueue(kind, payload) {
      const id = randomUUID();
      const now = Date.now();
      insert.run(id, kind, JSON.stringify(payload), 5, now, now);
      return id;
    },

    async flush(handler, flushOpts) {
      const now = Date.now();
      const rows = selectDue.all(now, 50) as Array<{
        id: string;
        kind: string;
        payload: string;
        attempts: number;
        max_attempts: number;
        last_error: string | null;
      }>;
      let processed = 0;
      for (const row of rows) {
        const delivery: OutboxDelivery = {
          id: row.id,
          kind: row.kind,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          nextAttemptAt: now,
          lastError: row.last_error ?? undefined,
        };
        try {
          await handler(delivery);
          deleteRow.run(row.id);
          processed += 1;
        } catch (err) {
          const attempts = row.attempts + 1;
          const error = err instanceof Error ? err.message : String(err);
          delivery.attempts = attempts;
          delivery.lastError = error;
          if (attempts >= row.max_attempts) {
            markDead.run(attempts, error, row.id);
            if (flushOpts?.onExhausted) {
              await flushOpts.onExhausted(delivery);
            }
          } else {
            updateAttempt.run(attempts, now + attempts * 1000, error, row.id);
          }
        }
      }
      return processed;
    },

    pendingCount() {
      const row = db.prepare("SELECT COUNT(*) as c FROM cw_outbox WHERE is_dead = 0").get() as {
        c: number;
      };
      return row.c;
    },

    deadCount() {
      const row = db.prepare("SELECT COUNT(*) as c FROM cw_outbox WHERE is_dead = 1").get() as {
        c: number;
      };
      return row.c;
    },
  };
}
