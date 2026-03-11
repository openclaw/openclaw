import type { PgClient } from "../db/postgres.js";

export async function createEmployee(
  pg: PgClient,
  params: {
    name: string;
    email?: string;
    role?: string;
    department?: string;
    start_date?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.employees (id, name, email, role, department, start_date, metadata)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      params.name,
      params.email ?? null,
      params.role ?? null,
      params.department ?? null,
      params.start_date ?? null,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
  return result.rows[0];
}

export async function getEmployee(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.employees WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listEmployees(
  pg: PgClient,
  params: { department?: string; status?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.department) {
    conditions.push(`department = $${idx++}`);
    values.push(params.department);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.employees ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateEmployee(pg: PgClient, id: string, params: Record<string, unknown>) {
  const keys = Object.keys(params);
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const result = await pg.query(
    `UPDATE erp.employees SET ${setClauses} WHERE id = $1 RETURNING *`,
    [id, ...Object.values(params)],
  );
  return result.rows[0] ?? null;
}

export async function deleteEmployee(pg: PgClient, id: string) {
  const result = await pg.query(
    "UPDATE erp.employees SET status = 'archived' WHERE id = $1 RETURNING *",
    [id],
  );
  return result.rows[0] ?? null;
}

export async function runPayroll(
  pg: PgClient,
  params: { employee_id: string; period: string; gross: number; deductions: number },
) {
  const net = params.gross - params.deductions;
  const result = await pg.query(
    `INSERT INTO erp.payroll (id, employee_id, period, gross, deductions, net, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'processed') RETURNING *`,
    [params.employee_id, params.period, params.gross, params.deductions, net],
  );
  return result.rows[0];
}
