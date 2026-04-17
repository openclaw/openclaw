import { executeQuery } from "./mysql-client.js";
import type { MySqlConfig, TopicResolution } from "./types.js";

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
    let params: unknown[];

    if (projectName) {
      sql =
        "SELECT topicId, masterId, slaveId FROM user_topic_mapping WHERE userId = ? AND projectName = ? LIMIT 1";
      params = [userId, projectName];
    } else {
      sql = "SELECT topicId, masterId, slaveId FROM user_topic_mapping WHERE userId = ? LIMIT 1";
      params = [userId];
    }

    const rows = await executeQuery<
      Array<{ topicId: number; masterId: number | null; slaveId: number | null }>
    >(config, sql, params);

    if (!rows || rows.length === 0) {
      return { topicId: null, useSlaveTopic: false };
    }

    const row = rows[0];
    const topicId = Number(row.topicId);
    const useSlaveTopic =
      (row.masterId != null && String(row.masterId) !== "0") ||
      (row.slaveId != null && String(row.slaveId) !== "0");

    return { topicId, useSlaveTopic };
  } catch (error) {
    throw new Error(`Failed to look up topicId for user ${userId}: ${error}`);
  }
}
