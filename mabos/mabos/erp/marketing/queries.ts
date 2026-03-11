import type { PgClient } from "../db/postgres.js";

export async function createCampaign(
  pg: PgClient,
  params: {
    name: string;
    type: string;
    status?: string;
    budget?: number;
    start_date?: string;
    end_date?: string;
    target_audience?: string;
    channels?: string[];
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.campaigns (id, name, type, status, budget, start_date, end_date, target_audience, channels)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      params.name,
      params.type,
      params.status ?? "draft",
      params.budget ?? null,
      params.start_date ?? null,
      params.end_date ?? null,
      params.target_audience ?? null,
      JSON.stringify(params.channels ?? []),
    ],
  );
  return result.rows[0];
}

export async function getCampaign(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.campaigns WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listCampaigns(
  pg: PgClient,
  params: { status?: string; type?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.type) {
    conditions.push(`type = $${idx++}`);
    values.push(params.type);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.campaigns ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateCampaign(pg: PgClient, id: string, params: Record<string, unknown>) {
  const allowed = [
    "name",
    "type",
    "status",
    "budget",
    "start_date",
    "end_date",
    "target_audience",
    "channels",
  ];
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const key of allowed) {
    if (key in params) {
      if (key === "channels") {
        sets.push(`${key} = $${idx++}`);
        values.push(JSON.stringify(params[key]));
      } else {
        sets.push(`${key} = $${idx++}`);
        values.push(params[key]);
      }
    }
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = now()`);
  values.push(id);
  const result = await pg.query(
    `UPDATE erp.campaigns SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function recordMetric(
  pg: PgClient,
  params: { campaign_id: string; metric_type: string; value: number },
) {
  const result = await pg.query(
    `INSERT INTO erp.campaign_metrics (id, campaign_id, metric_type, value, recorded_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now()) RETURNING *`,
    [params.campaign_id, params.metric_type, params.value],
  );
  return result.rows[0];
}

export async function getCampaignMetrics(pg: PgClient, campaignId: string, limit?: number) {
  const result = await pg.query(
    `SELECT * FROM erp.campaign_metrics WHERE campaign_id = $1 ORDER BY recorded_at DESC LIMIT $2`,
    [campaignId, limit ?? 50],
  );
  return result.rows;
}

export async function createKpi(
  pg: PgClient,
  params: {
    name: string;
    target: number;
    current?: number;
    unit?: string;
    period?: string;
    status?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.kpis (id, name, target, current, unit, period, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      params.name,
      params.target,
      params.current ?? 0,
      params.unit ?? null,
      params.period ?? null,
      params.status ?? "active",
    ],
  );
  return result.rows[0];
}

export async function listKpis(
  pg: PgClient,
  params: { status?: string; period?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.period) {
    conditions.push(`period = $${idx++}`);
    values.push(params.period);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.kpis ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateKpi(pg: PgClient, id: string, params: Record<string, unknown>) {
  const allowed = ["name", "target", "current", "unit", "period", "status"];
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const key of allowed) {
    if (key in params) {
      sets.push(`${key} = $${idx++}`);
      values.push(params[key]);
    }
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = now()`);
  values.push(id);
  const result = await pg.query(
    `UPDATE erp.kpis SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}
