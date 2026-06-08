import mysql from "mysql2/promise";
import type { HistoryDbConfig } from "./types.js";

/** One topic the user is authorized to view. */
export interface TopicInfo {
  topicId: number;
  /** True when the topicId came from slaveId and matches slaveTopicId downstream. */
  useSlaveTopic: boolean;
  /** Master topic id from entity_auth (0 when absent). */
  masterId: number;
  /** Project title from feed_topic (null when missing or lookup failed). */
  topicName: string | null;
}

export interface TopicResolution {
  /** Primary topic id: the user's most recently granted mapping (null when unmapped). */
  topicId: number | null;
  /** True when the topicId came from slaveId and matches slaveTopicId downstream. */
  useSlaveTopic: boolean;
  /** Master topic id from entity_auth (0 when absent). */
  masterId: number;
  /** Project title from feed_topic (null when unmapped or lookup failed). */
  topicName: string | null;
  /** Every distinct topic the user owns, sorted by topicId for deterministic prompts. */
  topics: TopicInfo[];
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

const EMPTY_RESOLUTION: TopicResolution = {
  topicId: null,
  useSlaveTopic: false,
  masterId: 0,
  topicName: null,
  topics: [],
};

/**
 * uid -> topic mappings change rarely, so a short TTL keeps every chat
 * message from hitting the DB while staying fresh enough for re-binding.
 * A stable resolution also keeps the injected message prefix deterministic
 * (prompt-cache friendly) across consecutive turns.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Map entity_auth rows to distinct topic mappings, preserving row order
 * (callers pass rows most-recent-first). Per-row rule:
 * - slaveId > 0: topicId = slaveId (matches slaveTopicId downstream)
 * - masterId > 0 and slaveId == 0: topicId = masterId
 * - otherwise: no mapping
 * A uid can hold many entity_auth rows (one per granted entity), often
 * repeating the same topic — duplicates keep their first (most recent) entry.
 */
function dedupeMappings(rows: mysql.RowDataPacket[]): Omit<TopicInfo, "topicName">[] {
  const seen = new Set<number>();
  const mappings: Omit<TopicInfo, "topicName">[] = [];
  for (const row of rows) {
    const masterId = Number(row.masterId) || 0;
    const slaveId = Number(row.slaveId) || 0;
    const mapping =
      slaveId > 0
        ? { topicId: slaveId, useSlaveTopic: true, masterId }
        : masterId > 0
          ? { topicId: masterId, useSlaveTopic: false, masterId }
          : null;
    if (mapping && !seen.has(mapping.topicId)) {
      seen.add(mapping.topicId);
      mappings.push(mapping);
    }
  }
  return mappings;
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
   * Look up every topic a user may view plus their feed_topic titles.
   * Superusers (su = 1) get every active daily-monitoring master topic;
   * everyone else gets their entity_auth ownership (many rows per uid), with
   * the primary topic (top-level fields) being the most recently granted
   * mapping. Results are cached per uid for CACHE_TTL_MS; on a DB failure a
   * stale entry (if any) is served instead of throwing.
   */
  async getTopicIdsByUser(userId: string): Promise<TopicResolution> {
    if (!userId) {
      return EMPTY_RESOLUTION;
    }

    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.resolution;
    }

    const pool = await this.getPool();

    try {
      // Superusers (legal_user_role.su = 1) administer every active
      // daily-monitoring project regardless of entity_auth grants; everyone
      // else is scoped to their entity_auth ownership. Keep this branch in
      // sync with extensions/feed-search/src/auth-topic-resolver.ts so the
      // injected chat prefix and the feed_query tool agree on topic scope.
      const mappings = (await this.isSuperUser(pool, userId))
        ? await this.resolveSuperUserMappings(pool)
        : await this.resolveEntityAuthMappings(pool, userId);
      const names = await this.lookupTopicNames(
        pool,
        mappings.map((m) => m.topicId),
      );
      // A transient feed_topic blip must not blank previously known titles:
      // that would flip the injected prefix shape for 5 minutes and
      // invalidate the prompt-cache prefix for the user.
      const previousNames = new Map(
        (cached?.resolution.topics ?? []).map((t) => [t.topicId, t.topicName]),
      );
      const topics = mappings.map((m) => ({
        ...m,
        topicName: names.get(m.topicId) ?? previousNames.get(m.topicId) ?? null,
      }));
      const primary = topics[0];
      const resolution: TopicResolution = primary
        ? { ...primary, topics: topics.toSorted((a, b) => a.topicId - b.topicId) }
        : EMPTY_RESOLUTION;
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

  /** True when legal_user_role.su = 1 for this user (missing row => not super). */
  private async isSuperUser(pool: mysql.Pool, userId: string): Promise<boolean> {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT su FROM legal_user_role WHERE id = ?",
      [userId],
    );
    return Number(rows?.[0]?.su) === 1;
  }

  /** Normal-user path: entity_auth ownership, newest grant first (index 0). */
  private async resolveEntityAuthMappings(
    pool: mysql.Pool,
    userId: string,
  ): Promise<Omit<TopicInfo, "topicName">[]> {
    // id DESC = grant order, newest first, so mappings[0] is the user's
    // most recent (current) project.
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT masterId, slaveId FROM entity_auth WHERE uid = ? ORDER BY id DESC",
      [userId],
    );
    return dedupeMappings(rows ?? []);
  }

  /**
   * Superuser path: the master feed_topic of every active (non-deleted)
   * Running daily-monitoring report. These are always master topics, so they
   * map to feed_monitor_item.topicId (useSlaveTopic = false, masterId =
   * topicId). Ordered by topic id for a deterministic primary and a
   * prompt-cache-stable prefix.
   */
  private async resolveSuperUserMappings(
    pool: mysql.Pool,
  ): Promise<Omit<TopicInfo, "topicName">[]> {
    const [reportRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM research_report WHERE status = 'Running' AND category = 'DailyMonitoring' AND deleted = 0",
    );
    const reportIds = (reportRows ?? []).map((r) => Number(r.id)).filter((id) => id > 0);
    if (reportIds.length === 0) {
      return [];
    }

    const placeholders = reportIds.map(() => "?").join(",");
    const [topicRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id FROM feed_topic WHERE master = 1 AND reportId IN (${placeholders}) ORDER BY id ASC`,
      reportIds,
    );

    const seen = new Set<number>();
    const mappings: Omit<TopicInfo, "topicName">[] = [];
    for (const row of topicRows ?? []) {
      const topicId = Number(row.id) || 0;
      if (topicId > 0 && !seen.has(topicId)) {
        seen.add(topicId);
        mappings.push({ topicId, useSlaveTopic: false, masterId: topicId });
      }
    }
    return mappings;
  }

  /**
   * Fetch project titles for the resolved topicIds from feed_topic in one
   * IN query. Titles are contextual sugar for the agent prompt, so any
   * failure (missing rows, DB blip) degrades to an empty map instead of
   * failing the resolution.
   */
  private async lookupTopicNames(
    pool: mysql.Pool,
    topicIds: number[],
  ): Promise<Map<number, string>> {
    if (topicIds.length === 0) {
      return new Map();
    }
    try {
      const placeholders = topicIds.map(() => "?").join(",");
      const [rows] = await pool.execute<mysql.RowDataPacket[]>(
        `SELECT id, title FROM feed_topic WHERE id IN (${placeholders})`,
        topicIds,
      );
      const names = new Map<number, string>();
      for (const row of rows ?? []) {
        const id = Number(row.id) || 0;
        const title = typeof row.title === "string" ? row.title.trim() : "";
        if (id > 0 && title) {
          names.set(id, title);
        }
      }
      return names;
    } catch {
      return new Map();
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
