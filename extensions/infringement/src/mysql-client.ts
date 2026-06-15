import mysql from "mysql2/promise";
import type { InfringementConfig, MySqlConfig, RabbitMqConfig } from "./types.js";

let readPool: mysql.Pool | null = null;
let writePool: mysql.Pool | null = null;

function readMysqlBlock(
  block: Record<string, unknown> | undefined,
  envPrefix: string,
): MySqlConfig {
  return {
    host: (block?.host as string) ?? process.env[`${envPrefix}_HOST`] ?? "127.0.0.1",
    port: Number(block?.port ?? process.env[`${envPrefix}_PORT`] ?? 3306),
    user: (block?.user as string) ?? process.env[`${envPrefix}_USER`] ?? "",
    password: (block?.password as string) ?? process.env[`${envPrefix}_PASSWORD`] ?? "",
    database: (block?.database as string) ?? process.env[`${envPrefix}_DATABASE`] ?? "superworker",
  };
}

/**
 * Resolve config from plugin config, falling back to env vars. The read account
 * may reuse FEED_MYSQL_* (same superworker DB as feed-search); the write account
 * must have INSERT/UPDATE on infringement_* (feed's btclaw_reader is read-only).
 */
export function resolveConfig(pluginConfig: Record<string, unknown>): InfringementConfig {
  const read = readMysqlBlock(
    pluginConfig.mysql as Record<string, unknown> | undefined,
    "FEED_MYSQL",
  );
  const write = readMysqlBlock(
    pluginConfig.writerDb as Record<string, unknown> | undefined,
    "WRITER_MYSQL",
  );

  const rabbitBlock = pluginConfig.rabbitmq as Record<string, unknown> | undefined;
  const rabbitmq: RabbitMqConfig = {
    host: (rabbitBlock?.host as string) ?? process.env.RABBITMQ_HOST ?? "127.0.0.1",
    port: Number(rabbitBlock?.port ?? process.env.RABBITMQ_PORT ?? 5672),
    user: (rabbitBlock?.user as string) ?? process.env.RABBITMQ_USER ?? "",
    password: (rabbitBlock?.password as string) ?? process.env.RABBITMQ_PASSWORD ?? "",
    taskQueue:
      (rabbitBlock?.taskQueue as string) ?? process.env.RABBITMQ_TASK_QUEUE ?? "TaskWorker",
  };

  return { read, write, rabbitmq };
}

function makePool(config: MySqlConfig, connectionLimit: number): mysql.Pool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit,
    waitForConnections: true,
    charset: "utf8mb4",
    timezone: "+08:00",
  });
}

/** Get or create the read-only pool. */
export function getReadPool(config: MySqlConfig): mysql.Pool {
  if (!readPool) {
    readPool = makePool(config, 3);
  }
  return readPool;
}

/** Get or create the write pool (smaller; writes are infrequent). */
export function getWritePool(config: MySqlConfig): mysql.Pool {
  if (!writePool) {
    writePool = makePool(config, 2);
  }
  return writePool;
}

/** Execute a read-only query and return rows. */
export async function executeQuery<T extends mysql.RowDataPacket[]>(
  config: MySqlConfig,
  sql: string,
  params?: ReadonlyArray<unknown>,
): Promise<T> {
  const pool = getReadPool(config);
  const [rows] = await pool.execute<T>(sql, (params ?? []) as mysql.ExecuteValues[]);
  return rows;
}

/**
 * Run `fn` inside a single write transaction on a dedicated connection.
 * Commits on success, rolls back on any throw, and always releases the
 * connection. Mirrors the beginTransaction/commit/rollback pattern in
 * InfringementController::analyzeAction.
 */
export async function withWriteTransaction<T>(
  config: MySqlConfig,
  fn: (conn: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  const pool = getWritePool(config);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      /* rollback best-effort */
    }
    throw error;
  } finally {
    conn.release();
  }
}

/** Close both pools (called during shutdown). */
export async function closePools(): Promise<void> {
  const pending: Array<Promise<void>> = [];
  if (readPool) {
    pending.push(readPool.end());
    readPool = null;
  }
  if (writePool) {
    pending.push(writePool.end());
    writePool = null;
  }
  await Promise.allSettled(pending);
}
