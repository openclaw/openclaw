import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import type { PluginLogger } from "../../api.js";
import { execute, query } from "../client/db-client.js";
import type { MySqlConfig } from "../client/types.js";
import type { Schedule, ScheduledTask } from "./types.js";

interface ScheduleRow extends RowDataPacket {
  id: string;
  uid: string;
  title: string;
  schedule: string;
  tz: string;
  action: string;
  session_key: string;
  mercure_topic: string;
  delivery: string;
  enabled: number;
  next_run_at: number | string;
  last_run_at: number | string | null;
  fail_count: number;
  created_at: number | string;
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schedule_tasks (
  id            VARCHAR(64)  NOT NULL PRIMARY KEY,
  uid           VARCHAR(64)  NOT NULL,
  title         VARCHAR(255) NOT NULL,
  schedule      JSON         NOT NULL,
  tz            VARCHAR(64)  NOT NULL,
  action        JSON         NOT NULL,
  session_key   TEXT         NOT NULL,
  mercure_topic VARCHAR(255) NOT NULL,
  delivery      JSON         NOT NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  next_run_at   BIGINT       NOT NULL,
  last_run_at   BIGINT       NULL,
  fail_count    INT          NOT NULL DEFAULT 0,
  created_at    BIGINT       NOT NULL,
  deleted       TINYINT(1)   NOT NULL DEFAULT 0,
  KEY idx_uid (uid),
  KEY idx_deleted_enabled_next (deleted, enabled, next_run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) {
    return fallback;
  }
  if (typeof raw === "object") {
    return raw as T; // mysql2 may already decode JSON columns
  }
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(row: ScheduleRow): ScheduledTask {
  return {
    id: row.id,
    uid: row.uid,
    title: row.title,
    schedule: parseJson<Schedule>(row.schedule, { kind: "interval", everyMinutes: 60 }),
    tz: row.tz,
    action: parseJson(row.action, { tool: "", params: {} }),
    sessionKey: row.session_key,
    mercureTopic: row.mercure_topic,
    delivery: parseJson(row.delivery, {}),
    enabled: Number(row.enabled) === 1,
    nextRunAt: Number(row.next_run_at),
    lastRunAt: row.last_run_at == null ? undefined : Number(row.last_run_at),
    failCount: Number(row.fail_count),
    createdAt: Number(row.created_at),
  };
}

/**
 * Durable registry of recurring scheduled tasks. Source of truth is MySQL
 * (`schedule_tasks` on superworker) when a db is configured, so the web frontend
 * can list/edit/delete the same rows the gateway executes; otherwise it falls
 * back to a JSON file under the plugin stateDir. In both modes an in-memory map
 * serves the synchronous reads; the scheduler calls reload() each tick to pick
 * up out-of-process (frontend) edits. Pinned to a process-global singleton
 * because register() runs once for tool discovery and once for the service.
 */
export class ScheduleStore {
  private readonly tasks = new Map<string, ScheduledTask>();
  private filePath: string | null = null;
  private db: MySqlConfig | null = null;
  private logger: PluginLogger | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private initialized = false;

  async init(filePath: string, logger: PluginLogger, db?: MySqlConfig): Promise<void> {
    this.filePath = filePath;
    this.logger = logger;
    this.db = db ?? null;
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    if (this.db) {
      // Best-effort auto-create. The connection user may lack the CREATE
      // privilege (least-privilege writer accounts), in which case the table is
      // expected to be provisioned out-of-band by an admin. Note: MySQL checks
      // the CREATE privilege even for `CREATE TABLE IF NOT EXISTS` on an
      // existing table, so this can throw with the table already present — keep
      // it isolated from reload() so a denied create never blocks loading.
      try {
        await execute(this.db, CREATE_TABLE);
      } catch (error) {
        logger.warn(
          `[LEADING_V2_SCHED] CREATE TABLE skipped (table should be pre-provisioned): ${String(error)}`,
        );
      }
      try {
        await this.reload();
        logger.info(`[LEADING_V2_SCHED] Loaded ${this.tasks.size} scheduled task(s) from MySQL`);
      } catch (error) {
        logger.warn(`[LEADING_V2_SCHED] MySQL schedule load failed: ${String(error)}`);
      }
      return;
    }
    await this.loadFromFile(filePath, logger);
  }

  private async loadFromFile(filePath: string, logger: PluginLogger): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const task = item as ScheduledTask;
          if (task && typeof task.id === "string") {
            this.tasks.set(task.id, task);
          }
        }
      }
      logger.info(`[LEADING_V2_SCHED] Loaded ${this.tasks.size} scheduled task(s) from ${filePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn(`[LEADING_V2_SCHED] Could not read schedule store: ${String(error)}`);
      }
    }
  }

  /** Re-read the durable store into the in-memory map (picks up frontend edits). */
  async reload(): Promise<void> {
    if (!this.db) {
      return; // JSON mode is single-process; no external writers to pick up.
    }
    try {
      const rows = await query<ScheduleRow[]>(
        this.db,
        "SELECT * FROM schedule_tasks WHERE deleted = 0",
        [],
      );
      this.tasks.clear();
      for (const row of rows) {
        this.tasks.set(row.id, rowToTask(row));
      }
    } catch (error) {
      this.logger?.warn(`[LEADING_V2_SCHED] reload failed: ${String(error)}`);
    }
  }

  add(task: ScheduledTask): void {
    this.tasks.set(task.id, task);
    void this.persist(task);
  }

  update(id: string, patch: Partial<ScheduledTask>): void {
    const existing = this.tasks.get(id);
    if (!existing) {
      return;
    }
    const next = { ...existing, ...patch };
    this.tasks.set(id, next);
    void this.persist(next);
  }

  remove(id: string): boolean {
    const had = this.tasks.delete(id);
    if (had) {
      void this.persist(undefined, id);
    }
    return had;
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  all(): ScheduledTask[] {
    return [...this.tasks.values()];
  }

  forUser(uid: string): ScheduledTask[] {
    return this.all().filter((t) => t.uid === uid);
  }

  /** Enabled tasks whose nextRunAt is due at `now`. */
  due(now: number): ScheduledTask[] {
    return this.all().filter((t) => t.enabled && t.nextRunAt <= now);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Write a single change through to the durable store, serialized via writeChain. */
  private persist(upsert?: ScheduledTask, removeId?: string): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      try {
        if (this.db) {
          await this.persistRowToDb(upsert, removeId);
        } else {
          await this.persistFile();
        }
      } catch (error) {
        this.logger?.warn(`[LEADING_V2_SCHED] Failed to persist schedule store: ${String(error)}`);
      }
    });
    return this.writeChain;
  }

  private async persistRowToDb(upsert?: ScheduledTask, removeId?: string): Promise<void> {
    if (!this.db) {
      return;
    }
    if (removeId) {
      // Soft delete: the writer account intentionally lacks the DELETE
      // privilege, so mark the row instead. reload() filters `deleted = 0`.
      await execute(this.db, "UPDATE schedule_tasks SET deleted = 1 WHERE id = ?", [removeId]);
      return;
    }
    if (!upsert) {
      return;
    }
    const t = upsert;
    await execute(
      this.db,
      `INSERT INTO schedule_tasks
         (id, uid, title, schedule, tz, action, session_key, mercure_topic, delivery,
          enabled, next_run_at, last_run_at, fail_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title=VALUES(title), schedule=VALUES(schedule), tz=VALUES(tz), action=VALUES(action),
         session_key=VALUES(session_key), mercure_topic=VALUES(mercure_topic), delivery=VALUES(delivery),
         enabled=VALUES(enabled), next_run_at=VALUES(next_run_at), last_run_at=VALUES(last_run_at),
         fail_count=VALUES(fail_count), deleted=0`,
      [
        t.id,
        t.uid,
        t.title,
        JSON.stringify(t.schedule),
        t.tz,
        JSON.stringify(t.action),
        t.sessionKey,
        t.mercureTopic,
        JSON.stringify(t.delivery ?? {}),
        t.enabled ? 1 : 0,
        t.nextRunAt,
        t.lastRunAt ?? null,
        t.failCount,
        t.createdAt,
      ],
    );
  }

  private async persistFile(): Promise<void> {
    if (!this.filePath) {
      return;
    }
    const filePath = this.filePath;
    const snapshot = JSON.stringify([...this.tasks.values()]);
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = join(dirname(filePath), `.${Date.now()}-${Math.round(performance.now())}.sched.tmp`);
    await writeFile(tmp, snapshot, "utf8");
    await rename(tmp, filePath);
  }
}

const STORE_SYMBOL = Symbol.for("openclaw.leading-v2.scheduleStore");

export function getSharedScheduleStore(): ScheduleStore {
  const g = globalThis as unknown as Record<symbol, ScheduleStore | undefined>;
  let store = g[STORE_SYMBOL];
  if (!store) {
    store = new ScheduleStore();
    g[STORE_SYMBOL] = store;
  }
  return store;
}
