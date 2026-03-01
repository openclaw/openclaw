import type { PgClient } from "../db/postgres.js";

export async function createProduct(
  pg: PgClient,
  params: {
    name: string;
    sku: string;
    price: number;
    currency?: string;
    category?: string;
    stock_qty?: number;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.products (id, name, sku, price, currency, category, stock_qty, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'active') RETURNING *`,
    [
      params.name,
      params.sku,
      params.price,
      params.currency ?? "USD",
      params.category ?? null,
      params.stock_qty ?? 0,
    ],
  );
  return result.rows[0];
}

export async function getProduct(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.products WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listProducts(
  pg: PgClient,
  params: { category?: string; status?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.category) {
    conditions.push(`category = $${idx++}`);
    values.push(params.category);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.products ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateProduct(
  pg: PgClient,
  id: string,
  params: Partial<{
    name: string;
    sku: string;
    price: number;
    currency: string;
    category: string;
    stock_qty: number;
    status: string;
  }>,
) {
  const keys = Object.keys(params).filter(
    (k) => (params as Record<string, unknown>)[k] !== undefined,
  );
  if (keys.length === 0) return null;
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map((k) => (params as Record<string, unknown>)[k]);
  const result = await pg.query(
    `UPDATE erp.products SET ${setClauses}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return result.rows[0] ?? null;
}

export async function createOrder(
  pg: PgClient,
  params: {
    customer_id: string;
    items: Array<{ product_id: string; quantity: number; unit_price: number }>;
    currency?: string;
  },
) {
  const items = params.items ?? [];
  const subtotal = items.reduce(
    (sum, item) => sum + (item.quantity ?? 1) * (item.unit_price ?? 0),
    0,
  );
  const tax = Math.round(subtotal * 0.1 * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  const result = await pg.query(
    `INSERT INTO erp.orders (id, customer_id, line_items, subtotal, tax, total, status, currency)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending', $6) RETURNING *`,
    [params.customer_id, JSON.stringify(items), subtotal, tax, total, params.currency ?? "USD"],
  );
  return result.rows[0];
}

export async function getOrder(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.orders WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listOrders(
  pg: PgClient,
  params: { status?: string; customer_id?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`o.status = $${idx++}`);
    values.push(params.status);
  }
  if (params.customer_id) {
    conditions.push(`o.customer_id = $${idx++}`);
    values.push(params.customer_id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT o.*, c.name AS customer_name, o.line_items AS items
     FROM erp.orders o
     LEFT JOIN erp.contacts c ON o.customer_id = c.id
     ${where} ORDER BY o.created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateOrderStatus(pg: PgClient, id: string, status: string) {
  const shippedClause = status === "shipped" ? ", shipped_at = now()" : "";
  const result = await pg.query(
    `UPDATE erp.orders SET status = $2${shippedClause}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status],
  );
  return result.rows[0] ?? null;
}
