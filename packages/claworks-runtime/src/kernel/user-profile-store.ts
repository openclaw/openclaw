/**
 * user-profile-store.ts — 用户画像存储
 *
 * 双层存储：内存缓存（快速读取）+ SQLite 持久化（重启保留）。
 * 运行时实例挂载到 ClaworksRuntime.userProfileStore。
 * perceive.intent 读取画像并注入 LLM prompt，提升个性化响应。
 *
 * 存储层：
 *   - 内存缓存 Map：同一进程内多次读取无需查 DB
 *   - SQLite cw_user_profiles 表：重启后恢复用户偏好
 *   - 无 DB 时降级为纯内存（向后兼容）
 *
 * 清理策略：
 *   - 内存层：7 天无活动自动清理（仅从缓存移除，DB 不删）
 *   - DB 层：保留永久记录，由 UPDATE 持续刷新
 */

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type ResponseStyle = "concise" | "detailed" | "structured";

export type UserProfile = {
  userId: string;
  name?: string;
  preferredLanguage?: string;
  preferredResponseStyle: ResponseStyle;
  recentTopics: string[];
  interactionCount: number;
  lastSeenAt: string;
  customNotes?: string;
};

// 最小化 DB 接口（仅 profile store 所需）
export type UserProfileDb = {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): void;
  };
};

// ── 常量 ──────────────────────────────────────────────────────────────────

const DEFAULT_STYLE: ResponseStyle = "concise";
const MAX_RECENT_TOPICS = 10;
// 7 天无活动从内存缓存移除（DB 记录永远保留）
const PROFILE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

// ── 接口 ──────────────────────────────────────────────────────────────────

export interface UserProfileStore {
  get(userId: string): UserProfile;
  update(userId: string, patch: Partial<Omit<UserProfile, "userId">>): void;
  addTopic(userId: string, topic: string): void;
  getPreferredStyle(userId: string): ResponseStyle;
  setName(userId: string, name: string): void;
  bump(userId: string): void;
  toPromptHint(userId: string): string;
  list(): UserProfile[];
}

// ── DB 行类型 ─────────────────────────────────────────────────────────────

type DbRow = {
  user_id: string;
  name: string | null;
  preferred_language: string | null;
  preferred_style: string;
  recent_topics: string;
  interaction_count: number;
  last_seen_at: string;
  custom_notes: string | null;
};

function rowToProfile(row: DbRow): UserProfile {
  let recentTopics: string[] = [];
  try {
    const parsed = JSON.parse(row.recent_topics);
    if (Array.isArray(parsed)) {
      recentTopics = parsed as string[];
    }
  } catch {
    // ignore malformed JSON
  }
  return {
    userId: row.user_id,
    name: row.name ?? undefined,
    preferredLanguage: row.preferred_language ?? undefined,
    preferredResponseStyle: (row.preferred_style as ResponseStyle) ?? DEFAULT_STYLE,
    recentTopics,
    interactionCount: row.interaction_count,
    lastSeenAt: row.last_seen_at,
    customNotes: row.custom_notes ?? undefined,
  };
}

// ── createUserProfileStore ────────────────────────────────────────────────

export function createUserProfileStore(db?: UserProfileDb): UserProfileStore {
  // 内存缓存层
  const cache = new Map<string, UserProfile & { _lastSeen: number }>();

  // 预编译 SQL（仅当 DB 存在时）
  const stmts = db
    ? {
        select: db.prepare(`SELECT * FROM cw_user_profiles WHERE user_id = ?`),
        upsert: db.prepare(`
          INSERT INTO cw_user_profiles
            (user_id, name, preferred_language, preferred_style,
             recent_topics, interaction_count, last_seen_at, custom_notes, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            name = excluded.name,
            preferred_language = excluded.preferred_language,
            preferred_style = excluded.preferred_style,
            recent_topics = excluded.recent_topics,
            interaction_count = excluded.interaction_count,
            last_seen_at = excluded.last_seen_at,
            custom_notes = excluded.custom_notes,
            updated_at = datetime('now')
        `),
        selectAll: db.prepare(`SELECT * FROM cw_user_profiles ORDER BY last_seen_at DESC`),
      }
    : null;

  function pruneIdle(): void {
    const cutoff = Date.now() - PROFILE_IDLE_MS;
    for (const [id, p] of cache) {
      if (p._lastSeen < cutoff) {
        cache.delete(id);
      }
    }
  }

  /** 从内存缓存读取；缺失时尝试从 DB 加载；都没有则创建默认值。 */
  function getOrCreate(userId: string): UserProfile & { _lastSeen: number } {
    const cached = cache.get(userId);
    if (cached) {
      return cached;
    }

    // 尝试从 DB 恢复
    if (stmts) {
      const row = stmts.select.get(userId) as DbRow | undefined;
      if (row) {
        const profile = rowToProfile(row);
        const entry = { ...profile, _lastSeen: Date.now() };
        cache.set(userId, entry);
        return entry;
      }
    }

    // 新用户：创建默认画像
    const fresh: UserProfile & { _lastSeen: number } = {
      userId,
      preferredResponseStyle: DEFAULT_STYLE,
      recentTopics: [],
      interactionCount: 0,
      lastSeenAt: new Date().toISOString(),
      _lastSeen: Date.now(),
    };
    cache.set(userId, fresh);
    return fresh;
  }

  /** 将画像写入 DB（幂等）。 */
  function persist(p: UserProfile): void {
    if (!stmts) {
      return;
    }
    try {
      stmts.upsert.run(
        p.userId,
        p.name ?? null,
        p.preferredLanguage ?? null,
        p.preferredResponseStyle,
        JSON.stringify(p.recentTopics),
        p.interactionCount,
        p.lastSeenAt,
        p.customNotes ?? null,
      );
    } catch {
      // DB 写入失败不应影响运行时，静默降级
    }
  }

  return {
    get(userId) {
      pruneIdle();
      const p = getOrCreate(userId);
      const { _lastSeen: _ls, ...profile } = p;
      return profile;
    },

    update(userId, patch) {
      const p = getOrCreate(userId);
      Object.assign(p, patch);
      p.lastSeenAt = new Date().toISOString();
      p._lastSeen = Date.now();
      persist(p);
    },

    addTopic(userId, topic) {
      const p = getOrCreate(userId);
      const topics = p.recentTopics.filter((t) => t !== topic);
      p.recentTopics = [topic, ...topics].slice(0, MAX_RECENT_TOPICS);
      p._lastSeen = Date.now();
      persist(p);
    },

    getPreferredStyle(userId) {
      return getOrCreate(userId).preferredResponseStyle;
    },

    setName(userId, name) {
      const p = getOrCreate(userId);
      p.name = name;
      p._lastSeen = Date.now();
      persist(p);
    },

    bump(userId) {
      const p = getOrCreate(userId);
      p.interactionCount += 1;
      p.lastSeenAt = new Date().toISOString();
      p._lastSeen = Date.now();
      persist(p);
    },

    toPromptHint(userId) {
      const p = getOrCreate(userId);
      const parts: string[] = [];
      if (p.name) {
        parts.push(`用户名：${p.name}`);
      }
      if (p.preferredLanguage) {
        parts.push(`语言：${p.preferredLanguage}`);
      }
      parts.push(`偏好风格：${p.preferredResponseStyle}`);
      if (p.recentTopics.length > 0) {
        parts.push(`近期话题：${p.recentTopics.slice(0, 3).join("、")}`);
      }
      if (p.interactionCount > 0) {
        parts.push(`历史交互次数：${p.interactionCount}`);
      }
      if (p.customNotes) {
        parts.push(`备注：${p.customNotes}`);
      }
      return parts.join("；");
    },

    list() {
      pruneIdle();
      // 优先从 DB 列出完整记录（包括缓存未加载的用户）
      if (stmts) {
        try {
          const rows = stmts.selectAll.all() as DbRow[];
          return rows.map(rowToProfile);
        } catch {
          // DB 读取失败，降级到内存
        }
      }
      return [...cache.values()].map(({ _lastSeen: _ls, ...p }) => p);
    },
  };
}
