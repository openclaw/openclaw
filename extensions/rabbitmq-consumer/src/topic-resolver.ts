import mysql from "mysql2/promise";
import type { HistoryDbConfig } from "./types.js";

/** A single project mapping candidate, used when disambiguation is needed. */
export interface ProjectCandidate {
  projectName: string;
  topicId: number;
  useSlaveTopic: boolean;
}

export interface TopicResolution {
  topicId: number | null;
  useSlaveTopic: boolean;
  /** True when the user has multiple project mappings and the message did not pin one down. */
  needsDisambiguation?: boolean;
  /** Candidate projects (name + resolved topicId) to present to the user. */
  candidates?: ProjectCandidate[];
}

/** TopicIds in range 328-349 use slaveId as the resolved topicId. */
const SLAVE_TOPIC_RANGE = new Set(
  Array.from({ length: 22 }, (_, i) => 328 + i), // 328-349
);

interface TopicResolverConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class TopicResolver {
  private readonly config: TopicResolverConfig;
  private pool: mysql.Pool | null = null;

  constructor(historyDbConfig: HistoryDbConfig) {
    this.config = {
      host: historyDbConfig.host,
      port: historyDbConfig.port,
      user: historyDbConfig.user,
      password: historyDbConfig.password,
      database: historyDbConfig.database,
    };
  }

  private async getPool(): Promise<mysql.Pool> {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectionLimit: 3,
        waitForConnections: true,
        charset: "utf8mb4",
        timezone: "+08:00",
      });
    }
    return this.pool;
  }

  /**
   * Look up topicId and useSlaveTopic for a given userId.
   * Queries the user_topic_mapping table.
   *
   * - 0 rows: no mapping (topicId null).
   * - 1 row: used directly, no disambiguation.
   * - 2+ rows: the message must uniquely match one project's name; if exactly
   *   one matches it is used, otherwise the result is flagged
   *   `needsDisambiguation` with the candidate `projectNames` so the caller can
   *   ask the user which project they mean.
   *
   * TopicIds 328-349 match against slaveTopicId downstream (useSlaveTopic).
   */
  async getTopicIdsByUser(userId: string, message?: string): Promise<TopicResolution> {
    if (!userId) {
      return { topicId: null, useSlaveTopic: false };
    }

    const pool = await this.getPool();
    const sql =
      "SELECT topicId, masterId, slaveId, projectName FROM user_topic_mapping WHERE userId = ?";

    try {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql, [userId]);

      if (!rows || rows.length === 0) {
        return { topicId: null, useSlaveTopic: false };
      }

      // Single mapping: no ambiguity, use it directly.
      if (rows.length === 1) {
        return this.resolveRow(rows[0]);
      }

      // Multiple mappings: try to pin down a unique project from the message.
      const text = message ?? "";
      const matches = rows.filter((row) => {
        const name = String(row.projectName ?? "").trim();
        return name.length > 0 && text.includes(name);
      });

      if (matches.length === 1) {
        return this.resolveRow(matches[0]);
      }

      // Zero or 2+ matches across multiple rows: ask the user which project.
      const candidates: ProjectCandidate[] = rows
        .map((row) => {
          const topicId = Number(row.topicId);
          return {
            projectName: String(row.projectName ?? "").trim(),
            topicId,
            useSlaveTopic: SLAVE_TOPIC_RANGE.has(topicId),
          };
        })
        .filter((candidate) => candidate.projectName.length > 0);

      return { topicId: null, useSlaveTopic: false, needsDisambiguation: true, candidates };
    } catch (error) {
      throw new Error(`Failed to look up topicId for user ${userId}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  private resolveRow(row: mysql.RowDataPacket): TopicResolution {
    const topicId = Number(row.topicId);
    const useSlaveTopic = SLAVE_TOPIC_RANGE.has(topicId);
    return { topicId, useSlaveTopic };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
