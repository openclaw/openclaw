import mysql from "mysql2/promise";
import type { HistoryDbConfig } from "./types.js";

export interface TopicResolution {
  topicId: number | null;
  /** True when the topicId came from slaveId and matches slaveTopicId downstream. */
  useSlaveTopic: boolean;
  /** Master topic id from entity_auth (0 when absent). */
  masterId: number;
  /** Project title from feed_topic (null when unmapped or lookup failed). */
  topicName: string | null;
}

interface TopicResolverConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

interface TopicCacheEntry {
  resolution: TopicResolution;
  expiresAt: number;
}

/**
 * uid -> topic mappings change rarely, so a short TTL keeps every chat
 * message from hitting the DB while staying fresh enough for re-binding.
 * A stable resolution also keeps the injected message prefix deterministic
 * (prompt-cache friendly) across consecutive turns.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Map an entity_auth row to a TopicResolution:
 * - slaveId > 0: topicId = slaveId (matches slaveTopicId downstream)
 * - masterId > 0 and slaveId == 0: topicId = masterId
 * - otherwise: no mapping (topicId null)
 */
function resolveFromRow(row: mysql.RowDataPacket | undefined): TopicResolution {
  if (!row) {
    return { topicId: null, useSlaveTopic: false, masterId: 0, topicName: null };
  }
  const masterId = Number(row.masterId) || 0;
  const slaveId = Number(row.slaveId) || 0;
  if (slaveId > 0) {
    return { topicId: slaveId, useSlaveTopic: true, masterId, topicName: null };
  }
  if (masterId > 0) {
    return { topicId: masterId, useSlaveTopic: false, masterId, topicName: null };
  }
  return { topicId: null, useSlaveTopic: false, masterId: 0, topicName: null };
}

export class TopicResolver {
  private readonly config: TopicResolverConfig;
  private pool: mysql.Pool | null = null;
  private readonly cache = new Map<string, TopicCacheEntry>();

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
   * Look up topicId, useSlaveTopic and the feed_topic title for a given
   * userId (entity_auth.uid). Results are cached per uid for CACHE_TTL_MS;
   * on a DB failure a stale entry (if any) is served instead of throwing.
   * Row-to-resolution mapping lives in resolveFromRow.
   */
  async getTopicIdsByUser(userId: string): Promise<TopicResolution> {
    if (!userId) {
      return { topicId: null, useSlaveTopic: false, masterId: 0, topicName: null };
    }

    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.resolution;
    }

    const pool = await this.getPool();
    const sql = "SELECT masterId, slaveId FROM entity_auth WHERE uid = ? LIMIT 1";

    try {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql, [userId]);
      const base = resolveFromRow(rows?.[0]);
      const freshName = await this.lookupTopicName(pool, base.topicId);
      // A transient feed_topic blip must not blank a previously known title
      // for the same topicId: that would flip the injected prefix shape for
      // 5 minutes and invalidate the prompt-cache prefix for the user.
      const previousName =
        cached && cached.resolution.topicId === base.topicId ? cached.resolution.topicName : null;
      const resolution = { ...base, topicName: freshName ?? previousName };
      this.cache.set(userId, { resolution, expiresAt: Date.now() + CACHE_TTL_MS });
      return resolution;
    } catch (error) {
      // Serve a stale entry over failing the message on a DB blip; ownership
      // mappings change rarely, so a stale resolution beats none at all.
      if (cached) {
        return cached.resolution;
      }
      throw new Error(`Failed to look up topicId for user ${userId}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Fetch the project title for a resolved topicId from feed_topic. The name
   * is contextual sugar for the agent prompt, so any failure (missing row,
   * DB blip) degrades to null instead of failing the resolution.
   */
  private async lookupTopicName(pool: mysql.Pool, topicId: number | null): Promise<string | null> {
    if (!topicId || topicId <= 0) {
      return null;
    }
    try {
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        "SELECT title FROM feed_topic WHERE id = ? LIMIT 1",
        [topicId],
      );
      const title = rows?.[0]?.title;
      return typeof title === "string" && title.trim() ? title.trim() : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    this.cache.clear();
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
