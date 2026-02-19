import type { PgClient } from "../db/postgres.js";

export async function createStockItem(
  pg: PgClient,
  params: {
    sku: string;
    name: string;
    quantity?: number;
    reorder_point?: number;
    warehouse_id?: string;
    status?: string;
    unit?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.stock_items (id, sku, name, quantity, reorder_point, warehouse_id, status, unit)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      params.sku,
      params.name,
      params.quantity ?? 0,
      params.reorder_point ?? 0,
      params.warehouse_id ?? null,
      params.status ?? "active",
      params.unit ?? null,
    ],
  );
  return result.rows[0];
}

export async function getStockItem(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.stock_items WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listStockItems(
  pg: PgClient,
  params: { warehouse_id?: string; status?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.warehouse_id) {
    conditions.push(`warehouse_id = $${idx++}`);
    values.push(params.warehouse_id);
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.stock_items ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function adjustStock(
  pg: PgClient,
  params: {
    stock_item_id: string;
    type: "in" | "out" | "adjustment";
    quantity: number;
    reason?: string;
    reference?: string;
  },
) {
  const movement = await pg.query(
    `INSERT INTO erp.stock_movements (id, stock_item_id, type, quantity, reason, reference)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING *`,
    [
      params.stock_item_id,
      params.type,
      params.quantity,
      params.reason ?? null,
      params.reference ?? null,
    ],
  );

  if (params.type === "in") {
    await pg.query(
      "UPDATE erp.stock_items SET quantity = quantity + $2, updated_at = now() WHERE id = $1",
      [params.stock_item_id, params.quantity],
    );
  } else if (params.type === "out") {
    await pg.query(
      "UPDATE erp.stock_items SET quantity = quantity - $2, updated_at = now() WHERE id = $1",
      [params.stock_item_id, params.quantity],
    );
  } else {
    // adjustment: set absolute value
    await pg.query("UPDATE erp.stock_items SET quantity = $2, updated_at = now() WHERE id = $1", [
      params.stock_item_id,
      params.quantity,
    ]);
  }

  return movement.rows[0];
}

export async function lowStockAlerts(pg: PgClient, threshold?: number) {
  const result =
    threshold != null
      ? await pg.query("SELECT * FROM erp.stock_items WHERE quantity <= $1 ORDER BY quantity ASC", [
          threshold,
        ])
      : await pg.query(
          "SELECT * FROM erp.stock_items WHERE quantity <= reorder_point ORDER BY quantity ASC",
        );
  return result.rows;
}

export async function getStockMovements(pg: PgClient, stockItemId: string, limit?: number) {
  const result = await pg.query(
    `SELECT * FROM erp.stock_movements WHERE stock_item_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [stockItemId, limit ?? 50],
  );
  return result.rows;
}
