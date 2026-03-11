import pg from "pg";

const { Pool } = pg;

export type PgClient = pg.Pool;
export type PgQueryResult = pg.QueryResult;

let pool: PgClient | null = null;

export function getErpPgPool(): PgClient {
  if (!pool) {
    pool = new Pool({
      host: process.env.MABOS_PG_HOST ?? "localhost",
      port: parseInt(process.env.MABOS_PG_PORT ?? "5432", 10),
      database: process.env.MABOS_PG_DATABASE ?? "mabos_erp",
      user: process.env.MABOS_PG_USER ?? "mabos",
      password: process.env.MABOS_PG_PASSWORD ?? "",
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  client: PgClient,
  sql: string,
  values?: unknown[],
): Promise<T[]> {
  const result = await client.query<T>(sql, values);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  client: PgClient,
  sql: string,
  values?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(client, sql, values);
  return rows[0] ?? null;
}

export async function transaction<T>(
  client: PgClient,
  fn: (conn: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const conn = await client.connect();
  try {
    await conn.query("BEGIN");
    const result = await fn(conn);
    await conn.query("COMMIT");
    return result;
  } catch (err) {
    await conn.query("ROLLBACK");
    throw err;
  } finally {
    conn.release();
  }
}

export async function closeErpPgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
