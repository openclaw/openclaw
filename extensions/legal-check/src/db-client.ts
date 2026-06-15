import mysql from "mysql2/promise";
import type { MySqlConfig } from "./types.js";

let pool: mysql.Pool | null = null;

function getPool(config: MySqlConfig): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 2,
      waitForConnections: true,
      charset: "utf8mb4",
      timezone: "+08:00",
    });
  }
  return pool;
}

export async function query<T extends mysql.RowDataPacket[]>(
  config: MySqlConfig,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Promise<T> {
  const [rows] = await getPool(config).execute<T>(sql, (params ?? []) as mysql.ExecuteValues[]);
  return rows;
}

export async function execute(
  config: MySqlConfig,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Promise<mysql.ResultSetHeader> {
  const [res] = await getPool(config).execute<mysql.ResultSetHeader>(
    sql,
    (params ?? []) as mysql.ExecuteValues[],
  );
  return res;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
