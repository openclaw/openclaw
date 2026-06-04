import mysql from "mysql2/promise";
import { executeQuery } from "./mysql-client.js";
import { logSqlQuery } from "./sql-logger.js";
import type { MySqlConfig, TopicResolution } from "./types.js";

/** TopicIds in range 328-349 use slaveId. */
const SLAVE_TOPIC_RANGE = new Set(
  Array.from({ length: 22 }, (_, i) => 328 + i), // 328-349
);

/**
 * Look up topicId and useSlaveTopic for a given userId + optional projectName.
 * Queries the user_topic_mapping table.
 */
export async function getTopicIdsByUser(
  config: MySqlConfig,
  userId: string,
  projectName?: string | null,
): Promise<TopicResolution> {
  if (!userId) {
    return { topicId: null, useSlaveTopic: false };
  }

  try {
    let sql: string;
    let params: mysql.ExecuteValues[];

    if (projectName) {
      sql =
        "SELECT topicId, masterId, slaveId FROM user_topic_mapping WHERE userId = ? AND projectName = ? LIMIT 1";
      params = [userId, projectName];
    } else {
      sql = "SELECT topicId, masterId, slaveId FROM user_topic_mapping WHERE userId = ? LIMIT 1";
      params = [userId];
    }

    const startTime = Date.now();
    const rows = await executeQuery<mysql.RowDataPacket[]>(config, sql, params);
    const durationMs = Date.now() - startTime;

    await logSqlQuery({
      tool: "getTopicIdsByUser",
      sql,
      params,
      userId,
      rowCount: rows.length,
      durationMs,
    });

    if (!rows || rows.length === 0) {
      return { topicId: null, useSlaveTopic: false };
    }

    const row = rows[0];
    const topicId = Number(row.topicId);
    const useSlaveTopic = SLAVE_TOPIC_RANGE.has(topicId);

    return { topicId, useSlaveTopic };
  } catch (error) {
    await logSqlQuery({
      tool: "getTopicIdsByUser",
      sql: "",
      params: [],
      userId,
      error: String(error),
    });
    throw new Error(`Failed to look up topicId for user ${userId}: ${String(error)}`, {
      cause: error,
    });
  }
}
