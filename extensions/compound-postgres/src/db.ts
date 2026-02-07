import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

const CONFIG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".openclaw",
  "postgres-audit.json",
);

export interface PostgresAuditConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

let pool: pg.Pool | null = null;

export function loadConfig(logger: Logger): PostgresAuditConfig | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      logger.info?.(`compound-postgres: config not found at ${CONFIG_PATH}, skipping`);
      return null;
    }
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as PostgresAuditConfig;
  } catch (err) {
    logger.warn(`compound-postgres: failed to read config: ${err}`);
    return null;
  }
}

export async function getPool(logger: Logger): Promise<pg.Pool | null> {
  if (pool) return pool;

  const config = loadConfig(logger);
  if (!config) return null;

  try {
    pool = new pg.Pool({
      connectionString: config.connectionString,
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // Test connectivity
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    logger.info("compound-postgres: connected to PostgreSQL");
    return pool;
  } catch (err) {
    logger.error(`compound-postgres: failed to connect: ${err}`);
    pool = null;
    return null;
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
