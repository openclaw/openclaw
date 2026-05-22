/**
 * context-engine.ts — ClaWorks 对话上下文引擎
 *
 * 让机器人跨轮次记住对话上下文，实现真正的对话连续性。
 * 内存实现：每个 sessionId 最多保留 50 轮，30 分钟无活动自动清理。
 */

export type ContextTurn = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
};

export type SessionSummary = {
  sessionId: string;
  turnCount: number;
  lastActiveAt: Date;
  firstTurnAt: Date;
};

export interface ContextEngine {
  /** 追加一条消息到会话上下文 */
  append(
    sessionId: string,
    role: "user" | "assistant" | "system",
    content: string,
    meta?: Record<string, unknown>,
  ): void;
  /** 获取最近 N 轮对话（用于 LLM prompt 构建） */
  getRecent(sessionId: string, maxTurns?: number): ContextTurn[];
  /** 获取所有活跃会话摘要 */
  listSessions(): SessionSummary[];
  /** 清除一个会话的上下文 */
  clear(sessionId: string): void;
  /** 压缩长上下文（超过 maxTurns 时保留最近 N 轮） */
  compress(sessionId: string, maxTurns?: number): Promise<void>;
  /** 将上下文保存到 DB（持久化，可选） */
  persist?(db: unknown): Promise<void>;
}

type SessionData = {
  turns: ContextTurn[];
  lastActiveAt: Date;
  firstTurnAt: Date;
};

const MAX_TURNS_PER_SESSION = 50;
const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 分钟

export type ContextEngineOptions = {
  /** 可选 LLM 完成函数；提供后 compress 使用 LLM 摘要替代简单截断 */
  llmComplete?: (params: { prompt: string }) => Promise<{ text: string }>;
};

export function createContextEngine(opts?: ContextEngineOptions): ContextEngine {
  const sessions = new Map<string, SessionData>();

  function getOrCreate(sessionId: string): SessionData {
    let data = sessions.get(sessionId);
    if (!data) {
      data = { turns: [], lastActiveAt: new Date(), firstTurnAt: new Date() };
      sessions.set(sessionId, data);
    }
    return data;
  }

  function pruneIdleSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, data] of sessions.entries()) {
      if (data.lastActiveAt.getTime() < cutoff) {
        sessions.delete(id);
      }
    }
  }

  return {
    append(sessionId, role, content, meta) {
      pruneIdleSessions();
      const data = getOrCreate(sessionId);
      data.turns.push({ role, content, timestamp: new Date(), meta });
      data.lastActiveAt = new Date();
      // 超过上限时删除最旧的轮次
      if (data.turns.length > MAX_TURNS_PER_SESSION) {
        data.turns.splice(0, data.turns.length - MAX_TURNS_PER_SESSION);
      }
    },

    getRecent(sessionId, maxTurns = 10) {
      const data = sessions.get(sessionId);
      if (!data) {
        return [];
      }
      const turns = data.turns;
      return turns.slice(Math.max(0, turns.length - maxTurns));
    },

    listSessions() {
      pruneIdleSessions();
      return [...sessions.entries()].map(([sessionId, data]) => ({
        sessionId,
        turnCount: data.turns.length,
        lastActiveAt: data.lastActiveAt,
        firstTurnAt: data.firstTurnAt,
      }));
    },

    clear(sessionId) {
      sessions.delete(sessionId);
    },

    async compress(sessionId, maxTurns = 10) {
      const data = sessions.get(sessionId);
      if (!data) {
        return;
      }
      if (data.turns.length <= maxTurns) {
        return;
      }
      const olderTurns = data.turns.slice(0, data.turns.length - maxTurns);
      const recentTurns = data.turns.slice(data.turns.length - maxTurns);
      if (opts?.llmComplete && olderTurns.length > 0) {
        // 用 LLM 将旧轮次摘要为一条 system 消息，保留对话语义
        const history = olderTurns.map((t) => `[${t.role}] ${t.content}`).join("\n");
        const prompt = [
          "将以下对话历史精炼为一段简洁的摘要（200字以内），保留关键决定、用户偏好和上下文信息：",
          "",
          history,
          "",
          "摘要：",
        ].join("\n");
        try {
          const { text } = await opts.llmComplete({ prompt });
          const summary: ContextTurn = {
            role: "system",
            content: `[历史摘要] ${text.trim()}`,
            timestamp: olderTurns[olderTurns.length - 1].timestamp,
            meta: { compressed: true, originalTurnCount: olderTurns.length },
          };
          data.turns = [summary, ...recentTurns];
        } catch {
          // LLM 摘要失败时回退到简单截断
          data.turns = recentTurns;
        }
      } else {
        // 无 LLM：简单截断保留最近 maxTurns 轮
        data.turns = recentTurns;
      }
    },

    async persist(_db) {
      // 内存实现：可选持久化，此处为 no-op
    },
  };
}
