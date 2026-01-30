/**
 * AssureBot - Storage Layer
 *
 * PostgreSQL for persistent data (tasks, audit)
 * Redis for caching and sessions
 */

import type { ScheduledTask } from "./scheduler.js";

export type StorageConfig = {
  postgres?: {
    url: string;
  };
  redis?: {
    url: string;
  };
};

export type Storage = {
  // Tasks
  saveTask: (task: ScheduledTask) => Promise<void>;
  getTask: (id: string) => Promise<ScheduledTask | null>;
  getAllTasks: () => Promise<ScheduledTask[]>;
  deleteTask: (id: string) => Promise<boolean>;

  // Conversations (Redis cache)
  getConversation: (userId: number) => Promise<ConversationMessage[]>;
  saveConversation: (userId: number, messages: ConversationMessage[]) => Promise<void>;
  clearConversation: (userId: number) => Promise<void>;

  // Health
  isHealthy: () => Promise<boolean>;
  close: () => Promise<void>;
};

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
};

/**
 * In-memory storage (fallback when no DB configured)
 */
function createMemoryStorage(): Storage {
  const tasks = new Map<string, ScheduledTask>();
  const conversations = new Map<number, ConversationMessage[]>();

  return {
    async saveTask(task) {
      tasks.set(task.id, task);
    },
    async getTask(id) {
      return tasks.get(id) || null;
    },
    async getAllTasks() {
      return Array.from(tasks.values());
    },
    async deleteTask(id) {
      return tasks.delete(id);
    },
    async getConversation(userId) {
      return conversations.get(userId) || [];
    },
    async saveConversation(userId, messages) {
      conversations.set(userId, messages);
    },
    async clearConversation(userId) {
      conversations.delete(userId);
    },
    async isHealthy() {
      return true;
    },
    async close() {
      // Nothing to close
    },
  };
}

/**
 * PostgreSQL storage for tasks
 */
async function createPostgresStorage(url: string): Promise<{
  saveTask: Storage["saveTask"];
  getTask: Storage["getTask"];
  getAllTasks: Storage["getAllTasks"];
  deleteTask: Storage["deleteTask"];
  isHealthy: () => Promise<boolean>;
  close: () => Promise<void>;
}> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url });

  // Create tables if not exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled BOOLEAN DEFAULT true,
      last_run TIMESTAMPTZ,
      last_status TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("[storage] PostgreSQL connected, tables ready");

  return {
    async saveTask(task) {
      await pool.query(
        `INSERT INTO scheduled_tasks (id, name, schedule, prompt, enabled, last_run, last_status, last_error, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = $2, schedule = $3, prompt = $4, enabled = $5,
           last_run = $6, last_status = $7, last_error = $8, updated_at = NOW()`,
        [
          task.id,
          task.name,
          task.schedule,
          task.prompt,
          task.enabled,
          task.lastRun || null,
          task.lastStatus || null,
          task.lastError || null,
        ]
      );
    },

    async getTask(id) {
      const result = await pool.query(
        "SELECT * FROM scheduled_tasks WHERE id = $1",
        [id]
      );
      if (result.rows.length === 0) return null;
      return rowToTask(result.rows[0]);
    },

    async getAllTasks() {
      const result = await pool.query("SELECT * FROM scheduled_tasks ORDER BY created_at");
      return result.rows.map(rowToTask);
    },

    async deleteTask(id) {
      const result = await pool.query(
        "DELETE FROM scheduled_tasks WHERE id = $1",
        [id]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async isHealthy() {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },

    async close() {
      await pool.end();
    },
  };
}

function rowToTask(row: Record<string, unknown>): ScheduledTask {
  return {
    id: row.id as string,
    name: row.name as string,
    schedule: row.schedule as string,
    prompt: row.prompt as string,
    enabled: row.enabled as boolean,
    lastRun: row.last_run ? new Date(row.last_run as string) : undefined,
    lastStatus: row.last_status as "ok" | "error" | undefined,
    lastError: row.last_error as string | undefined,
  };
}

/**
 * Redis storage for conversations/cache
 */
async function createRedisStorage(url: string): Promise<{
  getConversation: Storage["getConversation"];
  saveConversation: Storage["saveConversation"];
  clearConversation: Storage["clearConversation"];
  isHealthy: () => Promise<boolean>;
  close: () => Promise<void>;
}> {
  const { createClient } = await import("redis");
  const client = createClient({ url });

  client.on("error", (err) => console.error("[redis] Error:", err));
  await client.connect();

  console.log("[storage] Redis connected");

  const CONVERSATION_TTL = 60 * 60 * 24; // 24 hours
  const MAX_MESSAGES = 50;

  return {
    async getConversation(userId) {
      const key = `conv:${userId}`;
      const data = await client.get(key);
      if (!data) return [];
      try {
        return JSON.parse(data) as ConversationMessage[];
      } catch {
        return [];
      }
    },

    async saveConversation(userId, messages) {
      const key = `conv:${userId}`;
      // Keep only last N messages
      const trimmed = messages.slice(-MAX_MESSAGES);
      await client.setEx(key, CONVERSATION_TTL, JSON.stringify(trimmed));
    },

    async clearConversation(userId) {
      const key = `conv:${userId}`;
      await client.del(key);
    },

    async isHealthy() {
      try {
        await client.ping();
        return true;
      } catch {
        return false;
      }
    },

    async close() {
      await client.quit();
    },
  };
}

/**
 * Create storage based on config
 */
export async function createStorage(config: StorageConfig): Promise<Storage> {
  const memory = createMemoryStorage();

  let pgStorage: Awaited<ReturnType<typeof createPostgresStorage>> | null = null;
  let redisStorage: Awaited<ReturnType<typeof createRedisStorage>> | null = null;

  // Try PostgreSQL
  if (config.postgres?.url) {
    try {
      pgStorage = await createPostgresStorage(config.postgres.url);
    } catch (err) {
      console.error("[storage] PostgreSQL connection failed, using memory:", err);
    }
  }

  // Try Redis
  if (config.redis?.url) {
    try {
      redisStorage = await createRedisStorage(config.redis.url);
    } catch (err) {
      console.error("[storage] Redis connection failed, using memory:", err);
    }
  }

  return {
    // Tasks: prefer PostgreSQL, fallback to memory
    saveTask: pgStorage?.saveTask ?? memory.saveTask,
    getTask: pgStorage?.getTask ?? memory.getTask,
    getAllTasks: pgStorage?.getAllTasks ?? memory.getAllTasks,
    deleteTask: pgStorage?.deleteTask ?? memory.deleteTask,

    // Conversations: prefer Redis, fallback to memory
    getConversation: redisStorage?.getConversation ?? memory.getConversation,
    saveConversation: redisStorage?.saveConversation ?? memory.saveConversation,
    clearConversation: redisStorage?.clearConversation ?? memory.clearConversation,

    async isHealthy() {
      const pgOk = pgStorage ? await pgStorage.isHealthy() : true;
      const redisOk = redisStorage ? await redisStorage.isHealthy() : true;
      return pgOk && redisOk;
    },

    async close() {
      await pgStorage?.close();
      await redisStorage?.close();
    },
  };
}
