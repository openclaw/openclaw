import mysql from "mysql2/promise";
import type { MySqlConfig } from "./types.js";

let pool: mysql.Pool | null = null;

/**
 * Resolve MySQL config from plugin config or environment variables.
 * Plugin config takes precedence; env vars act as fallback.
 */
export function resolveConfig(pluginConfig: Record<string, unknown>): MySqlConfig {
  const mysqlCfg = pluginConfig.mysql as Record<string, unknown> | undefined;

  return {
    host: (mysqlCfg?.host as string) ?? process.env.FEED_MYSQL_HOST ?? "127.0.0.1",
    port: Number(mysqlCfg?.port ?? process.env.FEED_MYSQL_PORT ?? 3306),
    user: (mysqlCfg?.user as string) ?? process.env.FEED_MYSQL_USER ?? "",
    password: (mysqlCfg?.password as string) ?? process.env.FEED_MYSQL_PASSWORD ?? "",
    database: (mysqlCfg?.database as string) ?? process.env.FEED_MYSQL_DATABASE ?? "superworker",
  };
}

/** Get or create the MySQL connection pool (read-only, connectionLimit=3). */
export function getPool(config: MySqlConfig): mysql.Pool {
  if (pool) {
    return pool;
  }

  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: 3,
    waitForConnections: true,
    charset: "utf8mb4",
    timezone: "+08:00",
  });

  return pool;
}

/** Close the pool (called during shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Execute a read-only query and return rows. */
export async function executeQuery<T extends mysql.RowDataPacket[]>(
  config: MySqlConfig,
  sql: string,
  params?: mysql.ExecuteValues[],
): Promise<T> {
  const p = getPool(config);
  const [rows] = await p.execute<T>(sql, params ?? []);
  return rows;
}
