import type { PgClient } from "../db/postgres.js";

/* ── Reports ────────────────────────────────────────────────────────── */

export async function createReport(
  pg: PgClient,
  params: {
    name: string;
    type: string;
    query: string;
    parameters?: Record<string, unknown>;
    schedule?: string | null;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.reports (name, type, query, parameters, schedule, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING *`,
    [
      params.name,
      params.type,
      params.query,
      JSON.stringify(params.parameters ?? {}),
      params.schedule ?? null,
    ],
  );
  return result.rows[0];
}

export async function getReport(pg: PgClient, id: string) {
  const result = await pg.query(`SELECT * FROM erp.reports WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function listReports(
  pg: PgClient,
  params: { type?: string; status?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.type) {
    conditions.push(`type = $${idx++}`);
    values.push(params.type);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;

  const result = await pg.query(
    `SELECT * FROM erp.reports ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, limit],
  );
  return result.rows;
}

export async function runReport(pg: PgClient, reportId: string) {
  const report = await getReport(pg, reportId);
  if (!report) throw new Error(`Report ${reportId} not found`);

  /* Execute the stored query */
  const dataResult = await pg.query(report.query);

  /* Persist the snapshot */
  const snapshot = await pg.query(
    `INSERT INTO erp.data_snapshots (report_id, data, generated_at)
     VALUES ($1, $2, now())
     RETURNING *`,
    [reportId, JSON.stringify({ rows: dataResult.rows })],
  );

  /* Update last_run_at on the report */
  await pg.query(`UPDATE erp.reports SET last_run_at = now() WHERE id = $1`, [reportId]);

  return snapshot.rows[0];
}

export async function deleteReport(pg: PgClient, id: string) {
  const result = await pg.query(
    `UPDATE erp.reports SET status = 'archived' WHERE id = $1 RETURNING *`,
    [id],
  );
  return result.rows[0] ?? null;
}

/* ── Dashboards ─────────────────────────────────────────────────────── */

export async function createDashboard(
  pg: PgClient,
  params: {
    name: string;
    description?: string | null;
    widgets?: Array<{
      type: string;
      reportId: string;
      position: { x: number; y: number; w: number; h: number };
    }>;
    owner_id?: string | null;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.dashboards (name, description, widgets, owner_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      params.name,
      params.description ?? null,
      JSON.stringify(params.widgets ?? []),
      params.owner_id ?? null,
    ],
  );
  return result.rows[0];
}

export async function getDashboard(pg: PgClient, id: string) {
  const result = await pg.query(`SELECT * FROM erp.dashboards WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function listDashboards(pg: PgClient, params: { owner_id?: string; limit?: number }) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.owner_id) {
    conditions.push(`owner_id = $${idx++}`);
    values.push(params.owner_id);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;

  const result = await pg.query(
    `SELECT * FROM erp.dashboards ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, limit],
  );
  return result.rows;
}

/* ── Data Snapshots ─────────────────────────────────────────────────── */

export async function getSnapshots(pg: PgClient, reportId: string, limit?: number) {
  const result = await pg.query(
    `SELECT * FROM erp.data_snapshots
     WHERE report_id = $1
     ORDER BY generated_at DESC
     LIMIT $2`,
    [reportId, limit ?? 20],
  );
  return result.rows;
}
