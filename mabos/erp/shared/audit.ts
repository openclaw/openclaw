import { query } from "../db/postgres.js";
import type { PgClient } from "../db/postgres.js";

export async function writeAuditLog(
  pg: PgClient,
  entry: {
    domain: string;
    entityType: string;
    entityId: string;
    action: string;
    agentId: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await query(
    pg,
    `INSERT INTO erp.audit_log (domain, entity_type, entity_id, action, agent_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.domain,
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.agentId,
      JSON.stringify(entry.payload ?? {}),
    ],
  );
}

export async function queryAuditLog(
  pg: PgClient,
  filters: {
    domain?: string;
    entityType?: string;
    entityId?: string;
    agentId?: string;
    limit?: number;
  },
): Promise<unknown[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (filters.domain) {
    conditions.push(`domain = $${idx++}`);
    values.push(filters.domain);
  }
  if (filters.entityType) {
    conditions.push(`entity_type = $${idx++}`);
    values.push(filters.entityType);
  }
  if (filters.entityId) {
    conditions.push(`entity_id = $${idx++}`);
    values.push(filters.entityId);
  }
  if (filters.agentId) {
    conditions.push(`agent_id = $${idx++}`);
    values.push(filters.agentId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 100;
  return query(pg, `SELECT * FROM erp.audit_log ${where} ORDER BY created_at DESC LIMIT $${idx}`, [
    ...values,
    limit,
  ]);
}
