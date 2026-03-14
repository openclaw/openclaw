/**
 * Background Task Queue: Perplexity Computer-style async task execution.
 *
 * Enqueues tasks for background execution. Tasks run in the gateway process
 * and report results back to the workflow manager. Supports:
 * - One-shot tasks
 * - Recurring (scheduled) tasks via cron-like expressions
 * - Concurrency limits
 * - Retry on transient failures
 * - Progress notifications
 */

import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("acp/task-queue");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueuedTaskStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "retrying";

export type QueuedTask = {
  id: string;
  label: string;
  /** Async function to execute */
  fn: () => Promise<string>;
  status: QueuedTaskStatus;
  /** Number of remaining retry attempts */
  retriesLeft: number;
  /** Retry delay in ms */
  retryDelayMs: number;
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
  output?: string;
  error?: string;
  /** Workflow ID this task belongs to (optional) */
  workflowId?: string;
  /** Task ID within workflow (optional) */
  workflowTaskId?: string;
};

export type TaskQueueOptions = {
  maxConcurrency?: number;
  defaultRetries?: number;
  defaultRetryDelayMs?: number;
  onTaskComplete?: (task: QueuedTask) => void;
  onTaskFailed?: (task: QueuedTask) => void;
};

// ---------------------------------------------------------------------------
// Queue implementation
// ---------------------------------------------------------------------------

export class TaskQueue {
  private readonly queue: Map<string, QueuedTask> = new Map();
  private readonly running: Set<string> = new Set();
  private readonly maxConcurrency: number;
  private readonly defaultRetries: number;
  private readonly defaultRetryDelayMs: number;
  private readonly onTaskComplete?: (task: QueuedTask) => void;
  private readonly onTaskFailed?: (task: QueuedTask) => void;
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TaskQueueOptions = {}) {
    this.maxConcurrency = opts.maxConcurrency ?? 5;
    this.defaultRetries = opts.defaultRetries ?? 2;
    this.defaultRetryDelayMs = opts.defaultRetryDelayMs ?? 5_000;
    this.onTaskComplete = opts.onTaskComplete;
    this.onTaskFailed = opts.onTaskFailed;
  }

  /** Enqueue a task for background execution. Returns the task ID. */
  enqueue(params: {
    label: string;
    fn: () => Promise<string>;
    retries?: number;
    retryDelayMs?: number;
    workflowId?: string;
    workflowTaskId?: string;
  }): string {
    const id = crypto.randomUUID();
    const task: QueuedTask = {
      id,
      label: params.label,
      fn: params.fn,
      status: "queued",
      retriesLeft: params.retries ?? this.defaultRetries,
      retryDelayMs: params.retryDelayMs ?? this.defaultRetryDelayMs,
      enqueuedAt: Date.now(),
      workflowId: params.workflowId,
      workflowTaskId: params.workflowTaskId,
    };
    this.queue.set(id, task);
    log.debug(`Enqueued task "${params.label}" (${id})`);
    this.drain();
    return id;
  }

  /** Cancel a queued or running task. */
  cancel(id: string): boolean {
    const task = this.queue.get(id);
    if (!task) return false;
    if (task.status === "queued" || task.status === "retrying") {
      task.status = "cancelled";
      return true;
    }
    return false; // Cannot cancel running tasks
  }

  /** Get a task by ID. */
  get(id: string): QueuedTask | undefined {
    return this.queue.get(id);
  }

  /** List tasks, optionally by status. */
  list(filter?: { status?: QueuedTaskStatus; workflowId?: string }): QueuedTask[] {
    const tasks = [...this.queue.values()];
    return tasks.filter((t) => {
      if (filter?.status && t.status !== filter.status) return false;
      if (filter?.workflowId && t.workflowId !== filter.workflowId) return false;
      return true;
    });
  }

  /** Current queue depth (queued + running). */
  get size(): number {
    return [...this.queue.values()].filter(
      (t) => t.status === "queued" || t.status === "running" || t.status === "retrying",
    ).length;
  }

  /** Start a periodic drain loop. */
  startDrainLoop(intervalMs = 1_000): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => this.drain(), intervalMs);
  }

  /** Stop the drain loop. */
  stopDrainLoop(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private drain(): void {
    if (this.running.size >= this.maxConcurrency) return;

    const pending = [...this.queue.values()].filter((t) => t.status === "queued");
    const slots = this.maxConcurrency - this.running.size;

    for (const task of pending.slice(0, slots)) {
      this.runTask(task);
    }
  }

  private runTask(task: QueuedTask): void {
    task.status = "running";
    task.startedAt = Date.now();
    this.running.add(task.id);

    task
      .fn()
      .then((output) => {
        task.status = "done";
        task.output = output;
        task.completedAt = Date.now();
        this.running.delete(task.id);
        log.debug(`Task "${task.label}" (${task.id}) done`);
        this.onTaskComplete?.(task);
        this.drain();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.running.delete(task.id);

        if (task.retriesLeft > 0) {
          task.retriesLeft -= 1;
          task.status = "retrying";
          log.debug(`Task "${task.label}" failed, retrying in ${task.retryDelayMs}ms (${task.retriesLeft} left)`);
          setTimeout(() => {
            if (task.status === "retrying") {
              task.status = "queued";
              this.drain();
            }
          }, task.retryDelayMs);
        } else {
          task.status = "failed";
          task.error = message;
          task.completedAt = Date.now();
          log.warn(`Task "${task.label}" (${task.id}) failed permanently: ${message}`);
          this.onTaskFailed?.(task);
          this.drain();
        }
      });
  }
}

// Singleton
let _queue: TaskQueue | null = null;

export function getTaskQueue(opts?: TaskQueueOptions): TaskQueue {
  if (!_queue) {
    _queue = new TaskQueue(opts);
    _queue.startDrainLoop();
  }
  return _queue;
}
