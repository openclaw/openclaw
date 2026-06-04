import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Path to the SQL query log file */
const SQL_LOG_PATH = path.join(homedir(), ".openclaw", "logs", "feed-search-queries.jsonl");

/**
 * Append a SQL query log entry to the dedicated JSONL file.
 * Non-blocking — errors are silently ignored to never interfere with the tool.
 */
export async function logSqlQuery(entry: {
  tool: string;
  sql: string;
  params: unknown[];
  userId?: string | number;
  topicId?: number | null;
  topicField?: string | null;
  rowCount?: number;
  error?: string;
  durationMs?: number;
}): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SQL_LOG_PATH), { recursive: true });
    const line = JSON.stringify({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    await fs.appendFile(SQL_LOG_PATH, line + "\n", "utf8");
  } catch {
    // intentionally swallowed
  }
}
