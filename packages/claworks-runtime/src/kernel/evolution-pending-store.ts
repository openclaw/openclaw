/**
 * SQLite persistence for sandbox evolution promotions awaiting HITL.
 */
import type { CwDatabase } from "../planes/data/db-types.js";
import type { EvolutionPack, PendingSandboxPromotion } from "./evolution-sync.js";

export type PendingPromotionRow = {
  promotion_id: string;
  pack_json: string;
  playbook_ids: string;
  simulation_results: string;
  status: string;
  registered_at: number;
};

export function ensureEvolutionPendingPromotionsTable(db: CwDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cw_evolution_pending_promotions (
      promotion_id TEXT PRIMARY KEY,
      pack_json TEXT NOT NULL,
      playbook_ids TEXT NOT NULL,
      simulation_results TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      registered_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cw_evolution_pending_status
      ON cw_evolution_pending_promotions(status);
  `);
}

export function savePendingSandboxPromotion(
  db: CwDatabase,
  pending: PendingSandboxPromotion,
): void {
  ensureEvolutionPendingPromotionsTable(db);
  db.prepare(
    `INSERT INTO cw_evolution_pending_promotions
       (promotion_id, pack_json, playbook_ids, simulation_results, status, registered_at)
     VALUES (?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(promotion_id) DO UPDATE SET
       pack_json = excluded.pack_json,
       playbook_ids = excluded.playbook_ids,
       simulation_results = excluded.simulation_results,
       status = 'pending',
       registered_at = excluded.registered_at`,
  ).run(
    pending.promotion_id,
    JSON.stringify(pending.pack),
    JSON.stringify(pending.playbook_ids),
    JSON.stringify(pending.simulation_results),
    Date.parse(pending.registered_at),
  );
}

export function deletePendingSandboxPromotion(db: CwDatabase, promotionId: string): void {
  ensureEvolutionPendingPromotionsTable(db);
  db.prepare(`DELETE FROM cw_evolution_pending_promotions WHERE promotion_id = ?`).run(promotionId);
}

export function loadPendingSandboxPromotions(db: CwDatabase): PendingSandboxPromotion[] {
  ensureEvolutionPendingPromotionsTable(db);
  const rows = db
    .prepare(
      `SELECT promotion_id, pack_json, playbook_ids, simulation_results, registered_at
       FROM cw_evolution_pending_promotions
       WHERE status = 'pending'
       ORDER BY registered_at ASC`,
    )
    .all() as Array<Omit<PendingPromotionRow, "status">>;

  const pending: PendingSandboxPromotion[] = [];
  for (const row of rows) {
    try {
      pending.push({
        promotion_id: row.promotion_id,
        pack: JSON.parse(row.pack_json) as EvolutionPack,
        playbook_ids: JSON.parse(row.playbook_ids) as string[],
        simulation_results: JSON.parse(row.simulation_results) as Array<{
          playbook_id: string;
          passed: boolean;
          error?: string;
        }>,
        registered_at: new Date(row.registered_at).toISOString(),
      });
    } catch {
      // skip corrupt rows
    }
  }
  return pending;
}
