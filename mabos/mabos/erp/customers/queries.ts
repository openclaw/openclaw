import type { PgClient } from "../db/postgres.js";

export async function createContact(
  pg: PgClient,
  params: {
    name: string;
    email?: string;
    phone?: string;
    company?: string;
    segment?: string;
    lifecycle_stage?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.contacts (id, name, email, phone, company, segment, lifecycle_stage, metadata)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      params.name,
      params.email ?? null,
      params.phone ?? null,
      params.company ?? null,
      params.segment ?? null,
      params.lifecycle_stage ?? "lead",
      JSON.stringify(params.metadata ?? {}),
    ],
  );
  return result.rows[0];
}

export async function getContact(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.contacts WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listContacts(
  pg: PgClient,
  params: { segment?: string; lifecycle_stage?: string; limit?: number; offset?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.segment) {
    conditions.push(`segment = $${idx++}`);
    values.push(params.segment);
  }
  if (params.lifecycle_stage) {
    conditions.push(`lifecycle_stage = $${idx++}`);
    values.push(params.lifecycle_stage);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const result = await pg.query(
    `SELECT * FROM erp.contacts ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    [...values, limit, offset],
  );
  return result.rows;
}

export async function searchContacts(pg: PgClient, q: string, limit?: number) {
  const result = await pg.query(
    "SELECT * FROM erp.contacts WHERE name ILIKE $1 OR email ILIKE $1 OR company ILIKE $1 ORDER BY created_at DESC LIMIT $2",
    [`%${q}%`, limit ?? 50],
  );
  return result.rows;
}

export async function logInteraction(
  pg: PgClient,
  params: {
    contact_id: string;
    channel: string;
    type: string;
    summary: string;
    sentiment?: number;
    agent_id?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.interactions (id, contact_id, channel, type, summary, sentiment, agent_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      params.contact_id,
      params.channel,
      params.type,
      params.summary,
      params.sentiment ?? null,
      params.agent_id ?? null,
    ],
  );
  return result.rows[0];
}

export async function updateContact(pg: PgClient, id: string, params: Record<string, unknown>) {
  const keys = Object.keys(params);
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const result = await pg.query(`UPDATE erp.contacts SET ${setClauses} WHERE id = $1 RETURNING *`, [
    id,
    ...Object.values(params),
  ]);
  return result.rows[0] ?? null;
}

export async function deleteContact(pg: PgClient, id: string) {
  const result = await pg.query(
    "UPDATE erp.contacts SET lifecycle_stage = 'archived' WHERE id = $1 RETURNING *",
    [id],
  );
  return result.rows[0] ?? null;
}
