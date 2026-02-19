import type { PgClient } from "../db/postgres.js";

export async function createSupplier(
  pg: PgClient,
  params: {
    name: string;
    contact_email?: string;
    category?: string;
    rating?: number;
    terms?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.suppliers (id, name, contact_email, category, rating, status, terms)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active', $5) RETURNING *`,
    [
      params.name,
      params.contact_email ?? null,
      params.category ?? null,
      params.rating ?? null,
      params.terms ?? null,
    ],
  );
  return result.rows[0];
}

export async function getSupplier(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.suppliers WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listSuppliers(
  pg: PgClient,
  params: { status?: string; category?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.category) {
    conditions.push(`category = $${idx++}`);
    values.push(params.category);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.suppliers ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateSupplier(
  pg: PgClient,
  id: string,
  params: Partial<{
    name: string;
    contact_email: string;
    category: string;
    rating: number;
    status: string;
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
    `UPDATE erp.suppliers SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return result.rows[0] ?? null;
}

export async function createPurchaseOrder(
  pg: PgClient,
  params: {
    supplier_id: string;
    items: Array<{ description: string; quantity: number; unit_cost: number }>;
    expected_delivery?: string;
  },
) {
  const items = params.items ?? [];
  const totalCost = items.reduce(
    (sum, item) => sum + (item.quantity ?? 1) * (item.unit_cost ?? 0),
    0,
  );
  const result = await pg.query(
    `INSERT INTO erp.purchase_orders (id, supplier_id, line_items, total_cost, status, expected_delivery)
     VALUES (gen_random_uuid(), $1, $2, $3, 'draft', $4) RETURNING *`,
    [
      params.supplier_id,
      JSON.stringify(items),
      Math.round(totalCost * 100) / 100,
      params.expected_delivery ?? null,
    ],
  );
  return result.rows[0];
}

export async function getPurchaseOrder(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.purchase_orders WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listPurchaseOrders(
  pg: PgClient,
  params: { supplier_id?: string; status?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.supplier_id) {
    conditions.push(`supplier_id = $${idx++}`);
    values.push(params.supplier_id);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.purchase_orders ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function receivePurchaseOrder(pg: PgClient, id: string) {
  const result = await pg.query(
    `UPDATE erp.purchase_orders SET status = 'received', received_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id],
  );
  return result.rows[0] ?? null;
}
