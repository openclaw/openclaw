import type { RowDataPacket } from "mysql2/promise";
import { executeQuery } from "./mysql-client.js";
import type { MySqlConfig } from "./types.js";

/**
 * One topic the user is authorized to query.
 *
 * Two resolution paths feed this (see 权限问题.md):
 * - Superusers (legal_user_role.su = 1) get the master feed_topic of every
 *   active daily-monitoring report, independent of entity_auth grants.
 * - Everyone else goes through entity_auth ownership (masterId/slaveId),
 *   mirroring extensions/rabbitmq-consumer/src/topic-resolver.ts. NOTE: that
 *   blueprint still lacks the superuser branch; the injected chat prefix will
 *   under-report topics for su=1 accounts until it is updated to match.
 */
export interface AuthorizedTopic {
  topicId: number;
  /** True when the topicId came from slaveId and matches slaveTopicId downstream. */
  useSlaveTopic: boolean;
  /** Project title from feed_topic (null when missing or lookup failed). */
  topicName: string | null;
}

/** A resolved topic mapping before its title is attached. */
type TopicMapping = Omit<AuthorizedTopic, "topicName">;

interface CacheEntry {
  topics: AuthorizedTopic[];
  expiresAt: number;
}

/**
 * uid -> topic mappings change rarely; a short TTL keeps each tool call from
 * hitting the DB while staying fresh enough for re-binding.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Map entity_auth rows to distinct topic mappings, preserving row order
 * (rows arrive most-recent-first, so index 0 is the user's current project).
 * Per-row rule: slaveId > 0 wins (slave topic), else masterId > 0 (master
 * topic), else no mapping. Duplicates keep their first (most recent) entry.
 */
function dedupeMappings(rows: RowDataPacket[]): TopicMapping[] {
  const seen = new Set<number>();
  const mappings: TopicMapping[] = [];
  for (const row of rows) {
    const masterId = Number(row.masterId) || 0;
    const slaveId = Number(row.slaveId) || 0;
    const mapping =
      slaveId > 0
        ? { topicId: slaveId, useSlaveTopic: true }
        : masterId > 0
          ? { topicId: masterId, useSlaveTopic: false }
          : null;
    if (mapping && !seen.has(mapping.topicId)) {
      seen.add(mapping.topicId);
      mappings.push(mapping);
    }
  }
  return mappings;
}

/**
 * Resolves which feed topics a user may query, server-side. The userId comes
 * from the trusted tool factory context (never from LLM-supplied params), so
 * this resolver is the security boundary for topic scoping.
 */
export class AuthTopicResolver {
  private readonly config: MySqlConfig;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: MySqlConfig) {
    this.config = config;
  }

  /**
   * Look up every topic the user may query. Superusers (su = 1) get every
   * active daily-monitoring master topic; everyone else gets their entity_auth
   * grants (index 0 = most recently granted / current project). Results are
   * cached per uid for CACHE_TTL_MS; on a DB failure a stale entry (if any) is
   * served instead of throwing.
   */
  async getAuthorizedTopics(userId: string): Promise<AuthorizedTopic[]> {
    if (!userId) {
      return [];
    }

    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.topics;
    }

    try {
      const mappings = (await this.isSuperUser(userId))
        ? await this.resolveSuperUserTopics()
        : await this.resolveEntityAuthTopics(userId);
      const names = await this.lookupTopicNames(mappings.map((m) => m.topicId));
      // A transient feed_topic blip must not blank previously known titles
      // (matches the rabbitmq-consumer blueprint): a flipping topicName would
      // destabilize tool output and the prompt-cache prefix for 5 minutes.
      const previousNames = new Map((cached?.topics ?? []).map((t) => [t.topicId, t.topicName]));
      const topics = mappings.map((m) => ({
        ...m,
        topicName: names.get(m.topicId) ?? previousNames.get(m.topicId) ?? null,
      }));
      this.cache.set(userId, { topics, expiresAt: Date.now() + CACHE_TTL_MS });
      return topics;
    } catch (error) {
      // Serve a stale entry over failing the tool call on a DB blip;
      // ownership mappings change rarely, so stale beats none.
      if (cached) {
        return cached.topics;
      }
      throw new Error(`Failed to resolve authorized topics for user ${userId}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  /** True when legal_user_role.su = 1 for this user (missing row => not super). */
  private async isSuperUser(userId: string): Promise<boolean> {
    const rows = await executeQuery<RowDataPacket[]>(
      this.config,
      "SELECT su FROM legal_user_role WHERE id = ?",
      [userId],
    );
    return Number(rows?.[0]?.su) === 1;
  }

  /** Normal-user path: entity_auth ownership, newest grant first. */
  private async resolveEntityAuthTopics(userId: string): Promise<TopicMapping[]> {
    const rows = await executeQuery<RowDataPacket[]>(
      this.config,
      "SELECT masterId, slaveId FROM entity_auth WHERE uid = ? ORDER BY id DESC",
      [userId],
    );
    return dedupeMappings(rows ?? []);
  }

  /**
   * Superuser path: the master feed_topic of every active (non-deleted)
   * Running daily-monitoring report. Topics are always master topics, so they
   * map to feed_monitor_item.topicId (useSlaveTopic = false). Ordered by topic
   * id for a deterministic primary topic and prompt-cache-stable output.
   */
  private async resolveSuperUserTopics(): Promise<TopicMapping[]> {
    const reportRows = await executeQuery<RowDataPacket[]>(
      this.config,
      "SELECT id FROM research_report WHERE status = 'Running' AND category = 'DailyMonitoring' AND deleted = 0",
    );
    const reportIds = (reportRows ?? []).map((r) => Number(r.id)).filter((id) => id > 0);
    if (reportIds.length === 0) {
      return [];
    }

    const placeholders = reportIds.map(() => "?").join(",");
    const topicRows = await executeQuery<RowDataPacket[]>(
      this.config,
      `SELECT id FROM feed_topic WHERE master = 1 AND reportId IN (${placeholders}) ORDER BY id ASC`,
      reportIds,
    );

    const seen = new Set<number>();
    const mappings: TopicMapping[] = [];
    for (const row of topicRows ?? []) {
      const topicId = Number(row.id) || 0;
      if (topicId > 0 && !seen.has(topicId)) {
        seen.add(topicId);
        mappings.push({ topicId, useSlaveTopic: false });
      }
    }
    return mappings;
  }

  /**
   * Fetch project titles in one IN query. Titles are contextual sugar for
   * tool output, so any failure degrades to an empty map instead of failing
   * the resolution.
   */
  private async lookupTopicNames(topicIds: number[]): Promise<Map<number, string>> {
    if (topicIds.length === 0) {
      return new Map();
    }
    try {
      const placeholders = topicIds.map(() => "?").join(",");
      const rows = await executeQuery<RowDataPacket[]>(
        this.config,
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

  clearCache(): void {
    this.cache.clear();
  }
}
