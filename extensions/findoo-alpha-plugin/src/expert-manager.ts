/**
 * Expert Manager — background task orchestration for LangGraph analysis.
 *
 * Manages async submit → stream relay → SystemEvent → HeartbeatWake lifecycle.
 * Tasks are persisted to SQLite so in-flight analyses survive gateway restarts.
 */

import { LangGraphClient } from "./langgraph-client.js";
import { startStreamRelay, type StreamRelayHandle } from "./stream-relay.js";
import type { TaskStore, TaskRow } from "./task-store.js";

export type PendingTask = {
  taskId: string;
  threadId: string;
  label: string;
  productName: string;
  sessionKey: string;
  submittedAt: number;
  status: "running" | "completed" | "failed";
};

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type ExpertManagerConfig = {
  client: LangGraphClient;
  assistantId: string;
  enqueueSystemEvent: (text: string, options: { sessionKey: string; contextKey?: string }) => void;
  requestHeartbeatNow: (options?: { reason?: string; sessionKey?: string }) => void;
  logger: Logger;
  maxConcurrentTasks: number;
  taskStore?: TaskStore;
};

const PRODUCT_NAME = "Findoo Alpha";
const TASK_CLEANUP_MS = 30 * 60_000; // 30 min
const MAX_RECOVERY_RETRIES = 3;
const RECOVERY_POLL_INTERVAL_MS = 15_000;
const RECOVERY_ERROR_INTERVAL_MS = 30_000;
const RECOVERY_INITIAL_DELAY_MS = 3_000;
const MAX_TASK_LIFETIME_MS = 20 * 60_000; // 20 min

export class ExpertManager {
  private tasks = new Map<string, PendingTask>();
  private relays = new Map<string, StreamRelayHandle>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private recoveryTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastHealthy = false;

  constructor(private config: ExpertManagerConfig) {
    // Auto-cleanup completed/failed tasks every 5 min
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
  }

  /**
   * Submit an analysis task. Returns in <1s.
   * The actual analysis runs in the background via StreamRelay.
   */
  async submit(params: {
    query: string;
    context?: Record<string, unknown>;
    threadId?: string;
    sessionKey: string;
  }): Promise<{ taskId: string; threadId: string; label: string }> {
    // Concurrency check
    const running = [...this.tasks.values()].filter((t) => t.status === "running");
    if (running.length >= this.config.maxConcurrentTasks) {
      throw new Error(
        `已有 ${running.length} 个分析任务在运行，请等待完成后再提交。` +
          `（最大并发: ${this.config.maxConcurrentTasks}）`,
      );
    }

    const taskId = `fa-${Date.now()}`;
    const label = params.query.slice(0, 30).replace(/\s+/g, " ").trim() || "金融分析";

    // Create or reuse thread
    let threadId = params.threadId;
    if (!threadId) {
      const thread = await this.config.client.createThread({ taskId, query: params.query });
      threadId = thread.thread_id;
    }

    // Start streaming run (non-blocking — returns Response immediately)
    const resp = await this.config.client.createStreamingRun(
      threadId,
      [{ role: "user", content: params.query }],
      params.context,
    );

    // Register task (in-memory)
    const task: PendingTask = {
      taskId,
      threadId,
      label,
      productName: PRODUCT_NAME,
      sessionKey: params.sessionKey,
      submittedAt: Date.now(),
      status: "running",
    };
    this.tasks.set(taskId, task);

    // Persist to SQLite
    this.config.taskStore?.insert({
      taskId,
      threadId,
      sessionKey: params.sessionKey,
      label,
      query: params.query,
      submittedAt: task.submittedAt,
    });

    // Start stream relay in background
    const sseStream = LangGraphClient.parseSSE(resp.body!);
    const relay = startStreamRelay(sseStream, {
      taskId,
      sessionKey: params.sessionKey,
      productName: PRODUCT_NAME,
      label,
      enqueueSystemEvent: this.config.enqueueSystemEvent,
      requestHeartbeatNow: this.config.requestHeartbeatNow,
      logger: this.config.logger,
    });
    this.relays.set(taskId, relay);

    // Update task status when relay finishes
    relay.done.then((result) => {
      const t = this.tasks.get(taskId);
      const finalStatus = result.status === "completed" ? "completed" : "failed";
      if (t) {
        t.status = finalStatus;
      }
      // Persist status change
      this.config.taskStore?.updateStatus(taskId, finalStatus, {
        completedAt: Date.now(),
        error: finalStatus === "failed" ? result.finalText : undefined,
      });
      this.relays.delete(taskId);
      this.config.logger.info(
        `findoo-alpha: task ${taskId} ${result.status}` +
          (result.finalText ? ` (${result.finalText.slice(0, 80)}…)` : ""),
      );
    });

    this.config.logger.info(
      `findoo-alpha: submitted task ${taskId} thread=${threadId} label="${label}"`,
    );

    return { taskId, threadId, label };
  }

  /**
   * Recover in-flight tasks from a previous session.
   * Reads status="running" rows from SQLite, polls LangGraph for completion.
   */
  async recoverTasks(): Promise<void> {
    const store = this.config.taskStore;
    if (!store) return;

    const running = store.findRunning();
    if (running.length === 0) return;

    this.config.logger.info(
      `findoo-alpha: recovering ${running.length} in-flight task(s) from previous session`,
    );

    for (const row of running) {
      if (row.retries >= MAX_RECOVERY_RETRIES) {
        store.updateStatus(row.taskId, "lost", { completedAt: Date.now() });
        this.config.enqueueSystemEvent(
          `[Findoo Alpha] "${row.label}" 恢复失败（已重试 ${MAX_RECOVERY_RETRIES} 次），请重新提交分析。`,
          { sessionKey: row.sessionKey, contextKey: `findoo:alpha:${row.taskId}:lost` },
        );
        this.config.requestHeartbeatNow({ reason: "exec-event", sessionKey: row.sessionKey });
        this.config.logger.warn(`findoo-alpha: task ${row.taskId} marked lost after max retries`);
        continue;
      }

      store.incrementRetries(row.taskId);
      this.pollThreadForRecovery(row);
    }
  }

  /** Get pending/recent tasks, optionally filtered by sessionKey */
  getPendingTasks(sessionKey?: string): PendingTask[] {
    const all = [...this.tasks.values()];
    if (sessionKey) return all.filter((t) => t.sessionKey === sessionKey);
    return all;
  }

  /** Whether the LangGraph endpoint was reachable at last check */
  isHealthy(): boolean {
    return this.lastHealthy;
  }

  /** Update health status (called from index.ts healthCheck) */
  setHealthy(ok: boolean) {
    this.lastHealthy = ok;
  }

  /** Clean up old completed/failed tasks */
  private cleanup() {
    const cutoff = Date.now() - TASK_CLEANUP_MS;
    for (const [id, task] of this.tasks) {
      if (task.status !== "running" && task.submittedAt < cutoff) {
        this.tasks.delete(id);
      }
    }
    this.config.taskStore?.cleanup(TASK_CLEANUP_MS);
  }

  /** Dispose all resources */
  dispose() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    for (const timer of this.recoveryTimers) {
      clearTimeout(timer);
    }
    this.recoveryTimers.clear();
    for (const relay of this.relays.values()) {
      relay.abort();
    }
    this.relays.clear();
    this.tasks.clear();
    this.config.taskStore?.close();
  }

  /**
   * Poll LangGraph thread state to recover a task from a previous session.
   * Emits SystemEvent when the analysis completes or times out.
   */
  private pollThreadForRecovery(row: TaskRow): void {
    const poll = async () => {
      this.recoveryTimers.delete(timer);
      try {
        const state = (await this.config.client.getThreadState(row.threadId)) as {
          values?: { messages?: Array<{ content?: string }> };
        };

        const messages = state?.values?.messages;
        if (messages && messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.content) {
            // Thread completed on server side
            const summary = lastMsg.content.slice(0, 500);
            this.config.taskStore?.updateStatus(row.taskId, "completed", {
              completedAt: Date.now(),
            });
            this.config.enqueueSystemEvent(
              `[Findoo Alpha] "${row.label}" 分析完成（恢复）:\n${summary}`,
              { sessionKey: row.sessionKey, contextKey: `findoo:alpha:${row.taskId}:done` },
            );
            this.config.requestHeartbeatNow({
              reason: "exec-event",
              sessionKey: row.sessionKey,
            });
            this.config.logger.info(`findoo-alpha: recovered task ${row.taskId} — completed`);
            return;
          }
        }

        // Still running — check timeout
        const elapsed = Date.now() - row.submittedAt;
        if (elapsed > MAX_TASK_LIFETIME_MS) {
          this.config.taskStore?.updateStatus(row.taskId, "lost", {
            completedAt: Date.now(),
            error: "timeout after recovery polling",
          });
          this.config.enqueueSystemEvent(
            `[Findoo Alpha] "${row.label}" 超时（超过 20 分钟），请重新提交。`,
            { sessionKey: row.sessionKey, contextKey: `findoo:alpha:${row.taskId}:lost` },
          );
          this.config.requestHeartbeatNow({ reason: "exec-event", sessionKey: row.sessionKey });
          this.config.logger.warn(`findoo-alpha: task ${row.taskId} timed out during recovery`);
          return;
        }

        // Schedule next poll
        const nextTimer = setTimeout(poll, RECOVERY_POLL_INTERVAL_MS);
        this.recoveryTimers.add(nextTimer);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.config.logger.warn(`findoo-alpha: recovery poll failed for ${row.taskId}: ${errMsg}`);
        // Retry with longer interval on error
        const nextTimer = setTimeout(poll, RECOVERY_ERROR_INTERVAL_MS);
        this.recoveryTimers.add(nextTimer);
      }
    };

    // Delay initial poll to let gateway finish booting
    const timer = setTimeout(poll, RECOVERY_INITIAL_DELAY_MS);
    this.recoveryTimers.add(timer);
  }
}
