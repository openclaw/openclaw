/**
 * Expert Manager — background task orchestration for LangGraph analysis.
 *
 * Manages async submit → stream relay → SystemEvent → HeartbeatWake lifecycle.
 * No SQLite — tasks are ephemeral; LangGraph threads persist server-side.
 */

import { LangGraphClient } from "./langgraph-client.js";
import { startStreamRelay, type StreamRelayHandle } from "./stream-relay.js";

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
};

const PRODUCT_NAME = "Findoo Alpha";
const TASK_CLEANUP_MS = 30 * 60_000; // 30 min

export class ExpertManager {
  private tasks = new Map<string, PendingTask>();
  private relays = new Map<string, StreamRelayHandle>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
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

    // Register task
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
      if (t) {
        t.status = result.status === "completed" ? "completed" : "failed";
      }
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
  }

  /** Dispose all resources */
  dispose() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    for (const relay of this.relays.values()) {
      relay.abort();
    }
    this.relays.clear();
    this.tasks.clear();
  }
}
