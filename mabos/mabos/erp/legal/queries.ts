import type { PgClient } from "../db/postgres.js";

export async function createContract(
  pg: PgClient,
  params: {
    title: string;
    counterparty: string;
    type: string;
    value?: number;
    currency?: string;
    start_date?: string;
    end_date?: string;
    terms?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.contracts (id, title, counterparty, type, value, currency, status, start_date, end_date, terms)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'draft', $6, $7, $8) RETURNING *`,
    [
      params.title,
      params.counterparty,
      params.type,
      params.value ?? null,
      params.currency ?? null,
      params.start_date ?? null,
      params.end_date ?? null,
      params.terms ?? null,
    ],
  );
  return result.rows[0];
}

export async function getContract(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.contracts WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listContracts(
  pg: PgClient,
  params: { status?: string; counterparty?: string; type?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.counterparty) {
    conditions.push(`counterparty = $${idx++}`);
    values.push(params.counterparty);
  }
  if (params.type) {
    conditions.push(`type = $${idx++}`);
    values.push(params.type);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.contracts ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateContract(
  pg: PgClient,
  id: string,
  params: Partial<{
    title: string;
    counterparty: string;
    type: string;
    value: number;
    currency: string;
    status: string;
    start_date: string;
    end_date: string;
    terms: string;
  }>,
) {
  const keys = Object.keys(params).filter(
    (k) => (params as Record<string, unknown>)[k] !== undefined,
  );
  if (keys.length === 0) return null;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map((k) => (params as Record<string, unknown>)[k]);
  const result = await pg.query(
    `UPDATE erp.contracts SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return result.rows[0] ?? null;
}

export async function expiringContracts(pg: PgClient, withinDays: number) {
  const result = await pg.query(
    `SELECT * FROM erp.contracts
     WHERE end_date <= now() + make_interval(days => $1)
       AND end_date >= now()
       AND status = 'active'
     ORDER BY end_date ASC`,
    [withinDays],
  );
  return result.rows;
}

export async function createCase(
  pg: PgClient,
  params: {
    title: string;
    case_type: string;
    priority?: string;
    assigned_to?: string;
    description?: string;
    filed_date?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.legal_cases (id, title, case_type, status, priority, assigned_to, description, filed_date)
     VALUES (gen_random_uuid(), $1, $2, 'open', $3, $4, $5, $6) RETURNING *`,
    [
      params.title,
      params.case_type,
      params.priority ?? "medium",
      params.assigned_to ?? null,
      params.description ?? null,
      params.filed_date ?? null,
    ],
  );
  return result.rows[0];
}

export async function getCase(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.legal_cases WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listCases(
  pg: PgClient,
  params: { status?: string; case_type?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.case_type) {
    conditions.push(`case_type = $${idx++}`);
    values.push(params.case_type);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.legal_cases ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateCase(
  pg: PgClient,
  id: string,
  params: Partial<{
    title: string;
    case_type: string;
    status: string;
    priority: string;
    assigned_to: string;
    description: string;
  }>,
) {
  const keys = Object.keys(params).filter(
    (k) => (params as Record<string, unknown>)[k] !== undefined,
  );
  if (keys.length === 0) return null;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map((k) => (params as Record<string, unknown>)[k]);
  const result = await pg.query(
    `UPDATE erp.legal_cases SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return result.rows[0] ?? null;
}

// ── New Legal Queries (Redesign) ─────────────────────────────

// Partnership Contracts
export async function listPartnershipContracts(
  pg: PgClient,
  params: { status?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.partnership_contracts ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function createPartnershipContract(
  pg: PgClient,
  params: {
    partner_name: string;
    partner_type?: string;
    ownership_pct?: number;
    revenue_share_pct?: number;
    start_date?: string;
    end_date?: string;
    terms?: string;
    document_url?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.partnership_contracts (id, partner_name, partner_type, ownership_pct, revenue_share_pct, status, start_date, end_date, terms, document_url)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'draft', $5, $6, $7, $8) RETURNING *`,
    [
      params.partner_name,
      params.partner_type ?? null,
      params.ownership_pct ?? null,
      params.revenue_share_pct ?? null,
      params.start_date ?? null,
      params.end_date ?? null,
      params.terms ?? null,
      params.document_url ?? null,
    ],
  );
  return result.rows[0];
}

// Freelancer Contracts
export async function listFreelancerContracts(
  pg: PgClient,
  params: { status?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.freelancer_contracts ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function createFreelancerContract(
  pg: PgClient,
  params: {
    contractor_name: string;
    scope_of_work?: string;
    rate_type?: string;
    rate_amount: number;
    currency?: string;
    start_date?: string;
    end_date?: string;
    deliverables?: unknown[];
    document_url?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.freelancer_contracts (id, contractor_name, scope_of_work, rate_type, rate_amount, currency, status, start_date, end_date, deliverables, document_url)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9) RETURNING *`,
    [
      params.contractor_name,
      params.scope_of_work ?? null,
      params.rate_type ?? "hourly",
      params.rate_amount,
      params.currency ?? "USD",
      params.start_date ?? null,
      params.end_date ?? null,
      JSON.stringify(params.deliverables ?? []),
      params.document_url ?? null,
    ],
  );
  return result.rows[0];
}

// Corporate Documents
export async function listCorporateDocuments(
  pg: PgClient,
  params: { doc_type?: string; status?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.doc_type) {
    conditions.push(`doc_type = $${idx++}`);
    values.push(params.doc_type);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.corporate_documents ${where} ORDER BY filing_date DESC NULLS LAST LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

// Legal Structure
export async function getLegalStructure(pg: PgClient) {
  const result = await pg.query(
    "SELECT * FROM erp.legal_structure ORDER BY created_at ASC LIMIT 1",
  );
  return result.rows[0] ?? null;
}

// Compliance Guardrails
export async function listComplianceGuardrails(
  pg: PgClient,
  params: { active?: boolean; category?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.active !== undefined) {
    conditions.push(`active = $${idx++}`);
    values.push(params.active);
  }
  if (params.category) {
    conditions.push(`category = $${idx++}`);
    values.push(params.category);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.compliance_guardrails ${where} ORDER BY severity DESC, name ASC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}
