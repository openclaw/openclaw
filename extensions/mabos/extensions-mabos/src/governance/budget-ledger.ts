/**
 * Budget ledger — atomic cost tracking with reservation pattern.
 * Uses better-sqlite3 with WAL mode for concurrency.
 */

import Database from "better-sqlite3";
import { generatePrefixedId } from "../tools/common.js";
import type { BudgetAllocation, BudgetStatus, CostEvent } from "./types.js";
import { BudgetExhaustedError } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget_allocations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK(period_type IN ('daily', 'monthly', 'project')),
  period_key TEXT NOT NULL,
  limit_usd REAL NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, agent_id, period_type, period_key)
);

CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL DEFAULT 'default',
  agent_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_name TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

interface ReserveBudgetParams {
  companyId: string;
  agentId: string;
  estimatedCostUsd: number;
  sessionId?: string | null;
  toolName?: string | null;
}

interface RecordDirectCostParams {
  companyId: string;
  agentId: string;
  eventType: CostEvent["eventType"];
  amountUsd: number;
  sessionId?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  toolName?: string | null;
  metadata?: string | null;
}

export class BudgetLedger {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /**
   * Create or update a budget allocation for a given period.
   * If the allocation already exists, updates the limit.
   */
  ensureAllocation(
    companyId: string,
    agentId: string,
    periodType: BudgetAllocation["periodType"],
    periodKey: string,
    limitUsd: number,
  ): BudgetAllocation {
    const id = generatePrefixedId("ba");
    const stmt = this.db.prepare(`
      INSERT INTO budget_allocations (id, company_id, agent_id, period_type, period_key, limit_usd)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_id, agent_id, period_type, period_key)
      DO UPDATE SET limit_usd = excluded.limit_usd, updated_at = datetime('now')
    `);
    stmt.run(id, companyId, agentId, periodType, periodKey, limitUsd);

    const row = this.db
      .prepare(
        `SELECT * FROM budget_allocations
         WHERE company_id = ? AND agent_id = ? AND period_type = ? AND period_key = ?`,
      )
      .get(companyId, agentId, periodType, periodKey) as Record<string, unknown>;

    return this.rowToAllocation(row);
  }

  /**
   * Reserve budget atomically. Checks both daily and monthly limits.
   * Throws BudgetExhaustedError if either is exceeded.
   * Returns a reservation event ID that must be settled or released.
   */
  reserveBudget(params: ReserveBudgetParams): string {
    const { companyId, agentId, estimatedCostUsd, sessionId, toolName } = params;

    const reservationId = generatePrefixedId("ce");

    const txn = this.db.transaction(() => {
      // Check all active allocations for this agent
      const allocations = this.db
        .prepare(
          `SELECT * FROM budget_allocations
           WHERE company_id = ? AND agent_id = ?`,
        )
        .all(companyId, agentId) as Record<string, unknown>[];

      for (const alloc of allocations) {
        const available =
          (alloc.limit_usd as number) -
          (alloc.spent_usd as number) -
          (alloc.reserved_usd as number);
        if (estimatedCostUsd > available) {
          throw new BudgetExhaustedError(
            agentId,
            alloc.period_type as string,
            alloc.limit_usd as number,
            (alloc.spent_usd as number) + (alloc.reserved_usd as number),
            estimatedCostUsd,
          );
        }
      }

      // Reserve in all matching allocations
      this.db
        .prepare(
          `UPDATE budget_allocations
           SET reserved_usd = reserved_usd + ?, updated_at = datetime('now')
           WHERE company_id = ? AND agent_id = ?`,
        )
        .run(estimatedCostUsd, companyId, agentId);

      // Record reservation event
      this.db
        .prepare(
          `INSERT INTO cost_events (id, company_id, agent_id, session_id, event_type, amount_usd, tool_name)
           VALUES (?, ?, ?, ?, 'reservation', ?, ?)`,
        )
        .run(
          reservationId,
          companyId,
          agentId,
          sessionId ?? null,
          estimatedCostUsd,
          toolName ?? null,
        );
    });

    txn();
    return reservationId;
  }

  /**
   * Settle a reservation — move from reserved to spent with actual cost.
   */
  settleReservation(reservationId: string, actualCostUsd: number): void {
    const txn = this.db.transaction(() => {
      const event = this.db.prepare(`SELECT * FROM cost_events WHERE id = ?`).get(reservationId) as
        | Record<string, unknown>
        | undefined;

      if (!event || event.event_type !== "reservation") {
        throw new Error(`Reservation not found: ${reservationId}`);
      }

      const estimatedCost = event.amount_usd as number;
      const companyId = event.company_id as string;
      const agentId = event.agent_id as string;

      // Move from reserved to spent
      this.db
        .prepare(
          `UPDATE budget_allocations
           SET reserved_usd = reserved_usd - ?,
               spent_usd = spent_usd + ?,
               updated_at = datetime('now')
           WHERE company_id = ? AND agent_id = ?`,
        )
        .run(estimatedCost, actualCostUsd, companyId, agentId);

      // Update the event with actual cost
      this.db
        .prepare(`UPDATE cost_events SET amount_usd = ?, event_type = 'tool_call' WHERE id = ?`)
        .run(actualCostUsd, reservationId);
    });

    txn();
  }

  /**
   * Release a reservation (e.g. task was cancelled).
   */
  releaseReservation(reservationId: string): void {
    const txn = this.db.transaction(() => {
      const event = this.db.prepare(`SELECT * FROM cost_events WHERE id = ?`).get(reservationId) as
        | Record<string, unknown>
        | undefined;

      if (!event || event.event_type !== "reservation") {
        throw new Error(`Reservation not found: ${reservationId}`);
      }

      const estimatedCost = event.amount_usd as number;
      const companyId = event.company_id as string;
      const agentId = event.agent_id as string;

      // Remove from reserved
      this.db
        .prepare(
          `UPDATE budget_allocations
           SET reserved_usd = reserved_usd - ?,
               updated_at = datetime('now')
           WHERE company_id = ? AND agent_id = ?`,
        )
        .run(estimatedCost, companyId, agentId);

      // Record release event
      this.db
        .prepare(`UPDATE cost_events SET event_type = 'release' WHERE id = ?`)
        .run(reservationId);
    });

    txn();
  }

  /**
   * Record a direct cost (not via reservation pattern).
   */
  recordDirectCost(params: RecordDirectCostParams): string {
    const id = generatePrefixedId("ce");

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cost_events
           (id, company_id, agent_id, session_id, event_type, amount_usd, model, input_tokens, output_tokens, tool_name, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.companyId,
          params.agentId,
          params.sessionId ?? null,
          params.eventType,
          params.amountUsd,
          params.model ?? null,
          params.inputTokens ?? null,
          params.outputTokens ?? null,
          params.toolName ?? null,
          params.metadata ?? null,
        );

      // Update spent in allocations
      this.db
        .prepare(
          `UPDATE budget_allocations
           SET spent_usd = spent_usd + ?, updated_at = datetime('now')
           WHERE company_id = ? AND agent_id = ?`,
        )
        .run(params.amountUsd, params.companyId, params.agentId);
    });

    txn();
    return id;
  }

  /**
   * Get current budget status for an agent.
   */
  getBudgetStatus(companyId: string, agentId: string): BudgetStatus {
    const now = new Date();
    const dailyKey = now.toISOString().slice(0, 10);
    const monthlyKey = now.toISOString().slice(0, 7);

    const daily = this.db
      .prepare(
        `SELECT * FROM budget_allocations
         WHERE company_id = ? AND agent_id = ? AND period_type = 'daily' AND period_key = ?`,
      )
      .get(companyId, agentId, dailyKey) as Record<string, unknown> | undefined;

    const monthly = this.db
      .prepare(
        `SELECT * FROM budget_allocations
         WHERE company_id = ? AND agent_id = ? AND period_type = 'monthly' AND period_key = ?`,
      )
      .get(companyId, agentId, monthlyKey) as Record<string, unknown> | undefined;

    const dailyStatus = daily
      ? {
          limit: daily.limit_usd as number,
          spent: daily.spent_usd as number,
          reserved: daily.reserved_usd as number,
          remaining:
            (daily.limit_usd as number) -
            (daily.spent_usd as number) -
            (daily.reserved_usd as number),
        }
      : null;

    const monthlyStatus = monthly
      ? {
          limit: monthly.limit_usd as number,
          spent: monthly.spent_usd as number,
          reserved: monthly.reserved_usd as number,
          remaining:
            (monthly.limit_usd as number) -
            (monthly.spent_usd as number) -
            (monthly.reserved_usd as number),
        }
      : null;

    const canSpend =
      (!dailyStatus || dailyStatus.remaining > 0) &&
      (!monthlyStatus || monthlyStatus.remaining > 0);

    return { agentId, daily: dailyStatus, monthly: monthlyStatus, canSpend };
  }

  close(): void {
    this.db.close();
  }

  private rowToAllocation(row: Record<string, unknown>): BudgetAllocation {
    return {
      id: row.id as string,
      companyId: row.company_id as string,
      agentId: row.agent_id as string,
      periodType: row.period_type as BudgetAllocation["periodType"],
      periodKey: row.period_key as string,
      limitUsd: row.limit_usd as number,
      spentUsd: row.spent_usd as number,
      reservedUsd: row.reserved_usd as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
