import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { A2aMessageRecord, A2aTaskRecord } from "./protocol.js";

const A2A_TERMINAL_MAX_TASKS = 500;
const A2A_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const A2A_ERROR_MAX_LENGTH = 512;

type A2aTaskWaiter = {
  resolve: (task: A2aTaskRecord) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isTerminalTask(task: A2aTaskRecord): boolean {
  return task.status.state !== "TASK_STATE_SUBMITTED" && task.status.state !== "TASK_STATE_WORKING";
}

function createStatusMessage(contextId: string, text: string): A2aMessageRecord {
  return {
    messageId: randomUUID(),
    contextId,
    role: "ROLE_AGENT",
    parts: [{ text: truncateUtf16Safe(text, A2A_ERROR_MAX_LENGTH) }],
  };
}

export class A2aTaskStore {
  readonly #tasks = new Map<string, A2aTaskRecord>();
  readonly #taskOwners = new Map<string, string>();
  readonly #messageTasks = new Map<string, A2aTaskRecord>();
  readonly #taskMessageKeys = new Map<string, string>();
  readonly #terminalTasks = new Map<string, number>();
  readonly #waiters = new Map<string, Set<A2aTaskWaiter>>();

  create(contextId: string, ownerPeer?: string, messageId?: string): A2aTaskRecord {
    this.#pruneTerminalTasks();
    const messageKey = messageId === undefined ? undefined : JSON.stringify([ownerPeer, messageId]);
    const existing = messageKey === undefined ? undefined : this.#messageTasks.get(messageKey);
    if (existing) {
      return existing;
    }
    const task: A2aTaskRecord = {
      id: randomUUID(),
      contextId,
      status: { state: "TASK_STATE_SUBMITTED", timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
    };
    this.#tasks.set(task.id, task);
    if (ownerPeer !== undefined) {
      this.#taskOwners.set(task.id, ownerPeer);
    }
    if (messageKey !== undefined) {
      this.#messageTasks.set(messageKey, task);
      this.#taskMessageKeys.set(task.id, messageKey);
    }
    return task;
  }

  get(taskId: string, ownerPeer?: string): A2aTaskRecord | undefined {
    this.#pruneTerminalTasks();
    if (ownerPeer !== undefined && this.#taskOwners.get(taskId) !== ownerPeer) {
      return undefined;
    }
    return this.#tasks.get(taskId);
  }

  start(taskId: string): A2aTaskRecord | undefined {
    const task = this.#tasks.get(taskId);
    if (task?.status.state !== "TASK_STATE_SUBMITTED") {
      return undefined;
    }
    task.status = { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() };
    return task;
  }

  complete(taskId: string, text: string | undefined): A2aTaskRecord | undefined {
    const task = this.#tasks.get(taskId);
    if (!task || isTerminalTask(task)) {
      return task;
    }
    if (text?.trim()) {
      task.artifacts = [{ artifactId: randomUUID(), parts: [{ text }] }];
    }
    task.status = {
      state: "TASK_STATE_COMPLETED",
      timestamp: new Date().toISOString(),
      ...(!text?.trim()
        ? { message: createStatusMessage(task.contextId, "Agent completed without reply text") }
        : {}),
    };
    return this.#finishTask(task);
  }

  fail(taskId: string, error: unknown): A2aTaskRecord | undefined {
    const reason = error instanceof Error ? error.message : String(error);
    return this.#finishWithMessage(taskId, "TASK_STATE_FAILED", reason);
  }

  reject(taskId: string, reason: string): A2aTaskRecord | undefined {
    return this.#finishWithMessage(taskId, "TASK_STATE_REJECTED", reason);
  }

  wait(taskId: string, timeoutMs: number): Promise<A2aTaskRecord | undefined> {
    const task = this.get(taskId);
    if (!task || isTerminalTask(task)) {
      return Promise.resolve(task);
    }
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(taskId) ?? new Set<A2aTaskWaiter>();
      const waiter: A2aTaskWaiter = {
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            this.#waiters.delete(taskId);
          }
          resolve(task);
        }, timeoutMs),
      };
      waiters.add(waiter);
      this.#waiters.set(taskId, waiters);
    });
  }

  stop(): void {
    for (const task of this.#tasks.values()) {
      this.fail(task.id, "A2A channel stopped before completing the task");
    }
    this.#messageTasks.clear();
    this.#taskMessageKeys.clear();
    this.#terminalTasks.clear();
    this.#taskOwners.clear();
    this.#tasks.clear();
  }

  #finishWithMessage(
    taskId: string,
    state: "TASK_STATE_FAILED" | "TASK_STATE_REJECTED",
    reason: string,
  ): A2aTaskRecord | undefined {
    const task = this.#tasks.get(taskId);
    if (!task || isTerminalTask(task)) {
      return task;
    }
    task.status = {
      state,
      timestamp: new Date().toISOString(),
      message: createStatusMessage(task.contextId, reason),
    };
    return this.#finishTask(task);
  }

  #finishTask(task: A2aTaskRecord): A2aTaskRecord {
    this.#terminalTasks.set(task.id, Date.now());
    const waiters = this.#waiters.get(task.id);
    if (waiters) {
      this.#waiters.delete(task.id);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(task);
      }
    }
    this.#pruneTerminalTasks();
    return task;
  }

  #pruneTerminalTasks(): void {
    const expiresBefore = Date.now() - A2A_TERMINAL_RETENTION_MS;
    for (const [taskId, finishedAt] of this.#terminalTasks) {
      if (finishedAt > expiresBefore && this.#terminalTasks.size <= A2A_TERMINAL_MAX_TASKS) {
        break;
      }
      const messageKey = this.#taskMessageKeys.get(taskId);
      if (messageKey !== undefined) {
        this.#messageTasks.delete(messageKey);
        this.#taskMessageKeys.delete(taskId);
      }
      this.#terminalTasks.delete(taskId);
      this.#taskOwners.delete(taskId);
      this.#tasks.delete(taskId);
    }
  }
}
