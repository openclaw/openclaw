import type { PgClient } from "../db/postgres.js";

export async function createShipment(
  pg: PgClient,
  params: {
    order_id?: string;
    supplier_id?: string;
    origin: string;
    destination: string;
    carrier?: string;
    tracking_number?: string;
    status?: string;
    estimated_arrival?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.shipments (id, order_id, supplier_id, origin, destination, carrier, tracking_number, status, estimated_arrival)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      params.order_id ?? null,
      params.supplier_id ?? null,
      params.origin,
      params.destination,
      params.carrier ?? null,
      params.tracking_number ?? null,
      params.status ?? "pending",
      params.estimated_arrival ?? null,
    ],
  );
  return result.rows[0];
}

export async function getShipment(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.shipments WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listShipments(
  pg: PgClient,
  params: { status?: string; supplier_id?: string; limit?: number },
) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  if (params.supplier_id) {
    conditions.push(`supplier_id = $${idx++}`);
    values.push(params.supplier_id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.shipments ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function updateShipmentStatus(pg: PgClient, id: string, status: string) {
  const extras = status === "delivered" ? ", actual_arrival = now()" : "";
  const result = await pg.query(
    `UPDATE erp.shipments SET status = $2${extras}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

export async function trackShipment(pg: PgClient, trackingNumber: string) {
  const result = await pg.query("SELECT * FROM erp.shipments WHERE tracking_number = $1", [
    trackingNumber,
  ]);
  return result.rows[0] ?? null;
}

export async function createRoute(
  pg: PgClient,
  params: {
    name: string;
    origin: string;
    destination: string;
    legs?: unknown[];
    status?: string;
  },
) {
  const result = await pg.query(
    `INSERT INTO erp.routes (id, name, origin, destination, legs, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING *`,
    [
      params.name,
      params.origin,
      params.destination,
      JSON.stringify(params.legs ?? []),
      params.status ?? "active",
    ],
  );
  return result.rows[0];
}

export async function listRoutes(pg: PgClient, params: { status?: string; limit?: number }) {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (params.status) {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pg.query(
    `SELECT * FROM erp.routes ${where} ORDER BY created_at DESC LIMIT $${idx}`,
    [...values, params.limit ?? 50],
  );
  return result.rows;
}

export async function getRoute(pg: PgClient, id: string) {
  const result = await pg.query("SELECT * FROM erp.routes WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}
