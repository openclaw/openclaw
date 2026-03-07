/**
 * Async Task Queue (Optimized)
 *
 * Features:
 * - User-level concurrency isolation: each user has independent concurrency slots
 * - Dynamic priority: automatic priority boost after long queue times
 * - Complete cancellation mechanism: supports signal interruption for running tasks
 * - Task duration tracking: estimated and actual duration tracking
 */

import type { Logger } from "./shared/index.js";

/**
 * Task status
 */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Async task definition
 */
export interface AsyncTask {
  /** Task unique ID */
  id: string;
  /** Task type */
  type: string;
  /** Task description */
  description: string;
  /** User ID */
  userId: string;
  /** Conversation ID */
  conversationId: string;
  /** Task creation time */
  createdAt: Date;
  /** Task start time */
  startedAt?: Date;
  /** Task completion time */
  completedAt?: Date;
  /** Task status */
  status: TaskStatus;
  /** Execute function (receives AbortSignal for cooperative cancellation) */
  execute: (signal: AbortSignal) => Promise<void>;
  /** Abort controller */
  abortController: AbortController;
  /** Error message */
  error?: string;
  /** Result data */
  result?: unknown;
  /** Task priority (higher value = higher priority, default 0) */
  priority: number;
  /** Estimated duration (ms), used for wait time calculation */
  estimatedDurationMs?: number;
  /** Actual duration (ms) */
  actualDurationMs?: number;
  /** Queue wait time (ms) */
  queueWaitTimeMs?: number;
}

/**
 * Task queue configuration
 */
export interface TaskQueueConfig {
  /** Global max concurrency */
  maxConcurrency: number;
  /** Max concurrency per user (user isolation) */
  maxConcurrencyPerUser: number;
  /** Task timeout (milliseconds) */
  taskTimeoutMs: number;
  /** Dynamic priority: auto-boost after this wait time (ms) */
  priorityBoostThresholdMs: number;
  /** Dynamic priority: boost amount per check */
  priorityBoostAmount: number;
  /** Dynamic priority: check interval (ms) */
  priorityBoostIntervalMs: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: TaskQueueConfig = {
  maxConcurrency: 6,
  maxConcurrencyPerUser: 2, // Max 2 concurrent per user to prevent resource hogging
  taskTimeoutMs: 300000, // 5 minutes
  priorityBoostThresholdMs: 30000, // Boost priority after 30 seconds
  priorityBoostAmount: 5,
  priorityBoostIntervalMs: 10000, // Check every 10 seconds
};

/**
 * Task statistics
 */
export interface TaskStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

/**
 * Async task queue manager (optimized)
 *
 * Core improvements:
 * 1. User-level concurrency isolation: each user has independent concurrency counting
 * 2. Dynamic priority: auto-boost after long queue times
 * 3. Complete cancellation mechanism: AbortController signal interruption
 * 4. Duration tracking: estimated and actual duration recording
 */
export class AsyncTaskQueue {
  private queue: AsyncTask[] = [];
  private running: Map<string, AsyncTask> = new Map();
  private completed: Map<string, AsyncTask> = new Map();
  private config: TaskQueueConfig;
  private logger?: Logger;
  private taskIdCounter = 0;
  private static readonly MAX_COMPLETED_HISTORY = 100;

  /** Dynamic priority timer */
  private priorityBoostTimer?: ReturnType<typeof setInterval>;

  constructor(config?: Partial<TaskQueueConfig>, logger?: Logger) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.logger = logger;

    // Start dynamic priority adjustment timer
    this.startPriorityBoostTimer();
  }

  /**
   * Start dynamic priority adjustment timer
   */
  private startPriorityBoostTimer(): void {
    if (this.priorityBoostTimer) {
      clearInterval(this.priorityBoostTimer);
    }

    this.priorityBoostTimer = setInterval(() => {
      this.applyPriorityBoosts();
    }, this.config.priorityBoostIntervalMs);
  }

  /**
   * Apply priority boosts
   * Boost priority for pending tasks that have exceeded the wait threshold
   */
  private applyPriorityBoosts(): void {
    const now = Date.now();
    let boostedCount = 0;

    for (const task of this.queue) {
      if (task.status !== "pending") continue;

      const waitTime = now - task.createdAt.getTime();
      if (waitTime > this.config.priorityBoostThresholdMs) {
        // 根据等待时间计算提升倍数
        const boostMultiplier = Math.floor(waitTime / this.config.priorityBoostThresholdMs);
        const newPriority = task.priority + this.config.priorityBoostAmount * boostMultiplier;

        if (newPriority > task.priority) {
          task.priority = newPriority;
          boostedCount++;
          this.logger?.debug(
            `[AsyncTaskQueue] Priority boosted for task ${task.id}: ${task.priority} (waited ${Math.floor(waitTime / 1000)}s)`,
          );
        }
      }
    }

    if (boostedCount > 0) {
      this.logger?.debug(`[AsyncTaskQueue] Boosted ${boostedCount} tasks due to long wait times`);
    }
  }

  /**
   * Get running task count for specified user
   */
  private getUserRunningCount(userId: string): number {
    let count = 0;
    for (const task of this.running.values()) {
      if (task.userId === userId) count++;
    }
    return count;
  }

  /**
   * Generate task ID
   */
  private generateTaskId(): string {
    this.taskIdCounter++;
    const timestamp = Date.now().toString(36);
    const counter = this.taskIdCounter.toString(36).padStart(4, "0");
    return `${timestamp}-${counter}`.toUpperCase();
  }

  /**
   * Add task to queue
   * @param params Task parameters
   * @returns Created task
   */
  addTask(params: {
    type: string;
    description: string;
    userId: string;
    conversationId: string;
    execute: (signal: AbortSignal) => Promise<void>;
    priority?: number;
  }): AsyncTask {
    const task: AsyncTask = {
      id: this.generateTaskId(),
      type: params.type,
      description: params.description,
      userId: params.userId,
      conversationId: params.conversationId,
      createdAt: new Date(),
      status: "pending",
      execute: params.execute,
      abortController: new AbortController(),
      priority: params.priority ?? 0,
    };

    this.queue.push(task);
    this.logger?.debug(`[AsyncTaskQueue] Task added: ${task.id} - ${task.description}`);

    // Delay queue processing to ensure addTask() returns task object first
    // This allows caller to complete necessary setup before execute() is called (e.g., closure variable assignment)
    setImmediate(() => {
      this.processQueue().catch((err) => {
        this.logger?.error(`[AsyncTaskQueue] processQueue error: ${String(err)}`);
      });
    });

    return task;
  }

  /**
   * Process task queue (supports user-level concurrency isolation)
   */
  private async processQueue(): Promise<void> {
    // Check global concurrency limit
    if (this.running.size >= this.config.maxConcurrency) {
      return;
    }

    // Get highest priority pending tasks
    const pendingTasks = this.queue.filter((t) => t.status === "pending");
    if (pendingTasks.length === 0) {
      return;
    }
    pendingTasks.sort((a, b) => b.priority - a.priority);

    // Find first task that satisfies user concurrency limit
    let selectedTask: AsyncTask | null = null;
    for (const task of pendingTasks) {
      const userRunningCount = this.getUserRunningCount(task.userId);
      if (userRunningCount < this.config.maxConcurrencyPerUser) {
        selectedTask = task;
        break;
      }
    }

    // If no executable task found (all users at concurrency limit), wait
    if (!selectedTask) {
      this.logger?.debug(`[AsyncTaskQueue] All users at concurrency limit, waiting...`);
      return;
    }

    // Move to running
    const now = Date.now();
    selectedTask.status = "running";
    selectedTask.startedAt = new Date();
    selectedTask.queueWaitTimeMs = now - selectedTask.createdAt.getTime();
    this.running.set(selectedTask.id, selectedTask);
    this.queue = this.queue.filter((t) => t.id !== selectedTask!.id);

    this.logger?.debug(
      `[AsyncTaskQueue] Task started: ${selectedTask.id} ` +
        `(global: ${this.running.size}/${this.config.maxConcurrency}, ` +
        `user ${selectedTask.userId}: ${this.getUserRunningCount(selectedTask.userId)}/${this.config.maxConcurrencyPerUser}, ` +
        `waited: ${Math.floor(selectedTask.queueWaitTimeMs / 1000)}s)`,
    );

    // Execute task
    this.executeTask(selectedTask).finally(() => {
      // Continue processing queue after task completion
      this.processQueue().catch((err) => {
        this.logger?.error(
          `[AsyncTaskQueue] processQueue error after task completion: ${String(err)}`,
        );
      });
    });
  }

  /**
   * Execute single task (supports cancellation signal)
   */
  private async executeTask(task: AsyncTask): Promise<void> {
    const startTime = Date.now();

    // FIX: Track timeout handle to prevent timer leaks under load
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Task timeout after ${this.config.taskTimeoutMs}ms`));
      }, this.config.taskTimeoutMs);
    });

    // Cancellation signal Promise
    const cancelPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        reject(new Error("Task cancelled"));
      };

      if (task.abortController.signal.aborted) {
        onAbort();
        return;
      }

      task.abortController.signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      // Race: task execution (with signal for cooperative cancellation) vs timeout vs cancellation
      await Promise.race([
        task.execute(task.abortController.signal),
        timeoutPromise,
        cancelPromise,
      ]);

      task.status = "completed";
      task.completedAt = new Date();
      task.actualDurationMs = Date.now() - startTime;

      this.logger?.debug(
        `[AsyncTaskQueue] Task completed: ${task.id} ` +
          `(duration: ${Math.floor(task.actualDurationMs / 1000)}s)`,
      );
    } catch (error) {
      task.completedAt = new Date();
      task.actualDurationMs = Date.now() - startTime;

      if (task.abortController.signal.aborted) {
        task.status = "cancelled";
        task.error = "Task cancelled by user";
        this.logger?.debug(
          `[AsyncTaskQueue] Task cancelled: ${task.id} ` +
            `(ran for ${Math.floor(task.actualDurationMs / 1000)}s)`,
        );
      } else {
        task.status = "failed";
        task.error = error instanceof Error ? error.message : String(error);
        this.logger?.error(
          `[AsyncTaskQueue] Task failed: ${task.id} - ${task.error} ` +
            `(ran for ${Math.floor(task.actualDurationMs / 1000)}s)`,
        );
      }
    } finally {
      // FIX: Clear timeout to prevent dangling timers from accumulating
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      this.running.delete(task.id);
      this.completed.set(task.id, task);
      this.pruneCompletedHistory();
    }
  }

  /**
   * Evict oldest entries when the completed history exceeds the cap.
   */
  private pruneCompletedHistory(): void {
    if (this.completed.size <= AsyncTaskQueue.MAX_COMPLETED_HISTORY) {
      return;
    }
    const excess = this.completed.size - AsyncTaskQueue.MAX_COMPLETED_HISTORY;
    const iterator = this.completed.keys();
    for (let i = 0; i < excess; i++) {
      const key = iterator.next().value;
      if (key !== undefined) {
        this.completed.delete(key);
      }
    }
  }

  /**
   * Cancel specified task
   * @param taskId Task ID
   * @returns Whether cancellation was successful
   */
  cancelTask(taskId: string): boolean {
    // Check running tasks
    const runningTask = this.running.get(taskId);
    if (runningTask) {
      runningTask.abortController.abort();
      this.logger?.debug(`[AsyncTaskQueue] Task cancellation requested: ${taskId}`);
      return true;
    }

    // Check queued tasks
    const queueIndex = this.queue.findIndex((t) => t.id === taskId);
    if (queueIndex >= 0) {
      const task = this.queue[queueIndex];
      task.status = "cancelled";
      task.error = "Task cancelled before execution";
      task.completedAt = new Date();
      this.queue.splice(queueIndex, 1);
      this.completed.set(task.id, task);
      this.pruneCompletedHistory();
      this.logger?.debug(`[AsyncTaskQueue] Pending task cancelled: ${taskId}`);
      return true;
    }

    return false;
  }

  /**
   * Cancel all tasks for a user
   * @param userId User ID
   * @returns Number of cancelled tasks
   */
  cancelUserTasks(userId: string): number {
    let count = 0;

    // Cancel running tasks
    for (const [taskId, task] of this.running) {
      if (task.userId === userId) {
        task.abortController.abort();
        count++;
      }
    }

    // Cancel queued tasks
    const remainingQueue: AsyncTask[] = [];
    for (const task of this.queue) {
      if (task.userId === userId) {
        task.status = "cancelled";
        task.error = "Task cancelled before execution";
        task.completedAt = new Date();
        this.completed.set(task.id, task);
        count++;
      } else {
        remainingQueue.push(task);
      }
    }
    this.queue = remainingQueue;
    this.pruneCompletedHistory();

    this.logger?.debug(`[AsyncTaskQueue] Cancelled ${count} tasks for user: ${userId}`);
    return count;
  }

  /**
   * Get task info
   * @param taskId Task ID
   * @returns Task info or undefined
   */
  getTask(taskId: string): AsyncTask | undefined {
    // Check running tasks
    const runningTask = this.running.get(taskId);
    if (runningTask) {
      return runningTask;
    }

    // Check queued tasks
    const queuedTask = this.queue.find((t) => t.id === taskId);
    if (queuedTask) {
      return queuedTask;
    }

    // Check completed task history
    return this.completed.get(taskId);
  }

  /**
   * Get all tasks for a user
   * @param userId User ID
   * @returns Task list
   */
  getUserTasks(userId: string): AsyncTask[] {
    const runningTasks = Array.from(this.running.values()).filter((t) => t.userId === userId);
    const queuedTasks = this.queue.filter((t) => t.userId === userId);
    const completedTasks = Array.from(this.completed.values()).filter((t) => t.userId === userId);
    return [...runningTasks, ...queuedTasks, ...completedTasks];
  }

  /**
   * Get task statistics
   * @returns Statistics
   */
  getStats(): TaskStats {
    const pending = this.queue.length;
    const running = this.running.size;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;

    for (const task of this.completed.values()) {
      switch (task.status) {
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
        case "cancelled":
          cancelled++;
          break;
      }
    }

    return {
      pending,
      running,
      completed,
      failed,
      cancelled,
      total: pending + running + completed + failed + cancelled,
    };
  }

  /**
   * Get task statistics for a user
   * @param userId User ID
   * @returns Statistics
   */
  getUserStats(userId: string): TaskStats {
    const userTasks = this.getUserTasks(userId);
    const pending = userTasks.filter((t) => t.status === "pending").length;
    const running = userTasks.filter((t) => t.status === "running").length;
    const completed = userTasks.filter((t) => t.status === "completed").length;
    const failed = userTasks.filter((t) => t.status === "failed").length;
    const cancelled = userTasks.filter((t) => t.status === "cancelled").length;

    return {
      pending,
      running,
      completed,
      failed,
      cancelled,
      total: userTasks.length,
    };
  }

  /**
   * Format task status as emoji
   */
  static formatStatusEmoji(status: TaskStatus): string {
    switch (status) {
      case "pending":
        return "⏳";
      case "running":
        return "🔄";
      case "completed":
        return "✅";
      case "failed":
        return "❌";
      case "cancelled":
        return "🚫";
      default:
        return "❓";
    }
  }

  /**
   * Format task status as text
   */
  static formatStatusText(status: TaskStatus): string {
    switch (status) {
      case "pending":
        return "排队中";
      case "running":
        return "运行中";
      case "completed":
        return "已完成";
      case "failed":
        return "失败";
      case "cancelled":
        return "已取消";
      default:
        return "未知";
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<TaskQueueConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
    // Try to process queue after config update
    this.processQueue().catch((err) => {
      this.logger?.error(`[AsyncTaskQueue] processQueue error after config update: ${String(err)}`);
    });
  }

  /**
   * Get current configuration
   */
  getConfig(): TaskQueueConfig {
    return { ...this.config };
  }

  /**
   * Update priority for pending tasks
   *
   * Only affects tasks in queue that haven't started execution yet.
   * Automatically re-sorts queue after update.
   *
   * @param taskId Task ID
   * @param newPriority New priority (higher value = higher priority)
   * @returns Whether update was successful
   */
  updateTaskPriority(taskId: string, newPriority: number): boolean {
    const task = this.queue.find((t) => t.id === taskId && t.status === "pending");
    if (!task) {
      return false;
    }

    const oldPriority = task.priority;
    task.priority = newPriority;
    this.logger?.debug(
      `[AsyncTaskQueue] Task priority updated: ${taskId} (${oldPriority} -> ${newPriority})`,
    );
    return true;
  }

  /**
   * Insert urgent task at front of queue
   *
   * Creates a high-priority task and inserts it at queue head,
   * ensuring it gets priority execution when next slot is available.
   *
   * @param params Task parameters
   * @returns Created urgent task
   */
  insertUrgentTask(params: {
    type: string;
    description: string;
    userId: string;
    conversationId: string;
    execute: (signal: AbortSignal) => Promise<void>;
  }): AsyncTask {
    const maxPriority = this.queue.reduce((max, task) => Math.max(max, task.priority), 0);

    const task: AsyncTask = {
      id: this.generateTaskId(),
      type: params.type,
      description: params.description,
      userId: params.userId,
      conversationId: params.conversationId,
      createdAt: new Date(),
      status: "pending",
      execute: params.execute,
      abortController: new AbortController(),
      priority: maxPriority + 100,
    };

    this.queue.unshift(task);
    this.logger?.debug(
      `[AsyncTaskQueue] Urgent task inserted: ${task.id} - ${task.description} (priority: ${task.priority})`,
    );

    setImmediate(() => {
      this.processQueue().catch((err) => {
        this.logger?.error(`[AsyncTaskQueue] processQueue error: ${String(err)}`);
      });
    });

    return task;
  }

  /**
   * Boost priority for all pending tasks of a user
   *
   * @param userId User ID
   * @param boostAmount Priority boost amount
   * @returns Number of affected tasks
   */
  boostUserTaskPriority(userId: string, boostAmount: number = 10): number {
    let count = 0;
    for (const task of this.queue) {
      if (task.userId === userId && task.status === "pending") {
        task.priority += boostAmount;
        count++;
      }
    }

    if (count > 0) {
      this.logger?.debug(
        `[AsyncTaskQueue] Boosted ${count} tasks for user ${userId} by ${boostAmount}`,
      );
    }
    return count;
  }

  /**
   * Clear all tasks (use with caution)
   */
  clear(): void {
    // Stop priority adjustment timer
    if (this.priorityBoostTimer) {
      clearInterval(this.priorityBoostTimer);
      this.priorityBoostTimer = undefined;
    }

    // Cancel all running tasks
    for (const task of this.running.values()) {
      task.abortController.abort();
    }
    this.running.clear();

    // Clear queue and history
    this.queue = [];
    this.completed.clear();

    this.logger?.debug("[AsyncTaskQueue] All tasks cleared");
  }

  /**
   * Destroy queue (release resources)
   */
  destroy(): void {
    this.clear();
    this.logger?.debug("[AsyncTaskQueue] Queue destroyed");
  }

  /**
   * Get estimated wait time for tasks (milliseconds)
   * Estimates based on current queue length and average execution time
   */
  estimateWaitTime(userId: string): number {
    const userPendingTasks = this.queue.filter(
      (t) => t.userId === userId && t.status === "pending",
    ).length;

    // Get running task count for this user
    const userRunningCount = this.getUserRunningCount(userId);

    // Calculate how many tasks are ahead
    const tasksAhead = this.queue.filter((t) => {
      if (t.status !== "pending") return false;
      // Higher priority tasks are ahead
      if (t.userId === userId) return true;
      // Other users' tasks with higher priority also count as ahead
      return false;
    }).length;

    // Simple estimate: 30 seconds per task
    const avgTaskDuration = 30000;
    const availableSlots = Math.max(0, this.config.maxConcurrencyPerUser - userRunningCount);

    if (availableSlots > 0 && tasksAhead === 0) {
      return 0; // Can execute immediately
    }

    // Estimate wait time
    const estimatedWait =
      Math.ceil(tasksAhead / this.config.maxConcurrencyPerUser) * avgTaskDuration;
    return estimatedWait;
  }

  /**
   * Get queue status summary
   */
  getQueueStatus(): {
    globalRunning: number;
    globalMax: number;
    queueLength: number;
    userStats: Map<string, { running: number; pending: number }>;
  } {
    const userStats = new Map<string, { running: number; pending: number }>();

    // Count running tasks
    for (const task of this.running.values()) {
      const current = userStats.get(task.userId) ?? { running: 0, pending: 0 };
      current.running++;
      userStats.set(task.userId, current);
    }

    // Count queued tasks
    for (const task of this.queue) {
      if (task.status === "pending") {
        const current = userStats.get(task.userId) ?? { running: 0, pending: 0 };
        current.pending++;
        userStats.set(task.userId, current);
      }
    }

    return {
      globalRunning: this.running.size,
      globalMax: this.config.maxConcurrency,
      queueLength: this.queue.length,
      userStats,
    };
  }
}

/**
 * Global task queue instance
 */
let globalTaskQueue: AsyncTaskQueue | null = null;

/**
 * Get or create global task queue
 */
export function getGlobalTaskQueue(
  config?: Partial<TaskQueueConfig>,
  logger?: Logger,
): AsyncTaskQueue {
  if (!globalTaskQueue) {
    globalTaskQueue = new AsyncTaskQueue(config, logger);
  }
  return globalTaskQueue;
}

/**
 * Reset global task queue (for testing)
 */
export function resetGlobalTaskQueue(): void {
  globalTaskQueue?.clear();
  globalTaskQueue = null;
}
