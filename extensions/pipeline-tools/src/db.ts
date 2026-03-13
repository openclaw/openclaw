import pg from "pg";

let pool: pg.Pool | null = null;

type DbConfig = {
  databaseUrl?: string;
  maxPoolSize?: number;
};

export function getPool(config?: DbConfig): pg.Pool {
  if (pool) {
    return pool;
  }
  const connectionString =
    config?.databaseUrl || process.env.DATABASE_URL || "";
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Provide it via env or plugin config (plugins.entries.pipeline-tools.config.databaseUrl).",
    );
  }
  pool = new pg.Pool({
    connectionString,
    max: config?.maxPoolSize ?? 5,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export async function shutdownPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type QueryResult<T = Record<string, unknown>> = {
  rows: T[];
  rowCount: number;
};

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  config?: DbConfig,
): Promise<QueryResult<T>> {
  const p = getPool(config);
  const result = await p.query(sql, params);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}
