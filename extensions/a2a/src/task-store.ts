import { randomUUID } from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { logError } from "openclaw/plugin-sdk/logging-core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { A2aMessageRecord, A2aTaskRecord } from "./protocol.js";

const A2A_TERMINAL_MAX_TASKS = 500;
const A2A_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const A2A_ERROR_MAX_LENGTH = 512;

type StoredTerminalTask = {
  task: A2aTaskRecord;
  ownerPeer: string;
  messageKey: string;
  finishedAt: number;
};

type TerminalStore = Pick<PluginStateKeyedStore<StoredTerminalTask, 2>, "entries" | "register">;
type PendingStore = Pick<
  PluginStateKeyedStore<Omit<StoredTerminalTask, "finishedAt">, 2>,
  "entries" | "register" | "delete"
>;

export function openTerminalStore(runtime: PluginRuntime, accountId: string): TerminalStore {
  return runtime.state.openKeyedStoreV2<StoredTerminalTask>({
    namespace: `a2a-terminal-${accountId}`,
    maxEntries: A2A_TERMINAL_MAX_TASKS,
    defaultTtlMs: A2A_TERMINAL_RETENTION_MS,
  });
}

export function openPendingStore(runtime: PluginRuntime, accountId: string): PendingStore {
  return runtime.state.openKeyedStoreV2<Omit<StoredTerminalTask, "finishedAt">>({
    namespace: `a2a-pending-${accountId}`,
    maxEntries: 500,
    overflowPolicy: "reject-new",
  });
}

function isDefiniteStorageRefusal(
  error: unknown,
): error is Error & { code: "PLUGIN_STATE_LIMIT_EXCEEDED" | "PLUGIN_STATE_INVALID_INPUT" } {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "PLUGIN_STATE_LIMIT_EXCEEDED" || error.code === "PLUGIN_STATE_INVALID_INPUT")
  );
}

type A2aTaskWaiter = (task: A2aTaskRecord) => void;

function isTerminalTask(task: A2aTaskRecord): boolean {
  return [
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_REJECTED",
  ].includes(task.status.state);
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

  readonly #writes = new Map<string, Promise<A2aTaskRecord | undefined>>();
  readonly #starts = new Map<string, Promise<void>>();

  #lastFinishKey = 0;
  #stopped = false;

  constructor(
    private readonly terminalStore: TerminalStore,
    private readonly pendingStore: PendingStore,
  ) {}

  async restore(): Promise<void> {
    const entries = await this.terminalStore.entries();
    for (const { key, value } of entries) {
      const { task, ownerPeer, messageKey, finishedAt } = value;
      const finishKey = Number(key.split(":")[0]);
      if (!Number.isSafeInteger(finishKey) || finishKey < 0) {
        throw new Error("Invalid persisted A2A terminal task key");
      }
      this.#lastFinishKey = Math.max(this.#lastFinishKey, finishKey);
      if (!key.endsWith(`:${task.id}`) || !isTerminalTask(task) || !Number.isFinite(finishedAt)) {
        throw new Error("Invalid persisted A2A terminal task");
      }
      this.#tasks.set(task.id, task);
      this.#taskOwners.set(task.id, ownerPeer);
      this.#messageTasks.set(messageKey, task);
      this.#taskMessageKeys.set(task.id, messageKey);
      this.#terminalTasks.set(task.id, finishedAt);
    }
    this.#pruneTerminalTasks();
    // Failed cleanup can outlive terminal retention and a later use of the same
    // message ID. Retained results and the newest admission own replay identity.
    const pending = (await this.pendingStore.entries()).toSorted(
      (left, right) => right.createdAt - left.createdAt,
    );
    for (const { key, value } of pending) {
      const { task, ownerPeer, messageKey } = value;
      if (key !== task.id || task.status.state !== "TASK_STATE_WORKING") {
        throw new Error("Invalid persisted A2A pending task");
      }
      if (this.#messageTasks.has(messageKey)) {
        await this.#deletePending(task.id);
        continue;
      }
      this.#tasks.set(task.id, task);
      this.#taskOwners.set(task.id, ownerPeer);
      this.#messageTasks.set(messageKey, task);
      this.#taskMessageKeys.set(task.id, messageKey);
      await this.fail(
        task.id,
        "Gateway restarted before the task outcome was recorded. External effects may have occurred; inspect them before submitting new work. This task will not be dispatched again.",
      );
    }
  }

  create(contextId: string, ownerPeer: string, messageId: string): A2aTaskRecord {
    if (this.#stopped) {
      throw new Error("A2A channel stopped before accepting the task");
    }
    this.#pruneTerminalTasks();
    const messageKey = JSON.stringify([ownerPeer, messageId]);
    const existing = this.#messageTasks.get(messageKey);
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
    this.#taskOwners.set(task.id, ownerPeer);
    this.#messageTasks.set(messageKey, task);
    this.#taskMessageKeys.set(task.id, messageKey);
    return task;
  }

  get(taskId: string, ownerPeer: string): A2aTaskRecord | undefined {
    this.#pruneTerminalTasks();
    if (this.#taskOwners.get(taskId) !== ownerPeer) {
      return undefined;
    }
    return this.#tasks.get(taskId);
  }

  async start(taskId: string): Promise<A2aTaskRecord | undefined> {
    const existing = this.#starts.get(taskId);
    if (existing) {
      await existing;
      return undefined;
    }
    const task = this.#tasks.get(taskId);
    if (this.#stopped || task?.status.state !== "TASK_STATE_SUBMITTED") {
      return undefined;
    }
    task.status = { state: "TASK_STATE_WORKING", timestamp: new Date().toISOString() };
    // Admission must survive a crash before any agent turn or successful response.
    // Keep an uncertain acknowledgement fenced until restart reconciles storage.
    const admission = (async () => {
      try {
        await this.pendingStore.register(task.id, {
          task,
          ownerPeer: this.#taskOwners.get(task.id)!,
          messageKey: this.#taskMessageKeys.get(task.id)!,
        });
      } catch (error) {
        if (isDefiniteStorageRefusal(error)) {
          this.#deleteTask(task.id);
        }
        throw error;
      }
    })();
    this.#starts.set(taskId, admission);
    await admission;
    return this.#stopped ? undefined : task;
  }

  async complete(taskId: string, text: string | undefined): Promise<A2aTaskRecord | undefined> {
    const task = this.#tasks.get(taskId);
    if (!task || isTerminalTask(task)) {
      return task;
    }
    const terminal = { ...task };
    if (text?.trim()) {
      terminal.artifacts = [{ artifactId: randomUUID(), parts: [{ text }] }];
    }
    terminal.status = {
      state: "TASK_STATE_COMPLETED",
      timestamp: new Date().toISOString(),
      ...(!text?.trim()
        ? { message: createStatusMessage(task.contextId, "Agent completed without reply text") }
        : {}),
    };
    return this.#finishTask(task, terminal);
  }

  async fail(taskId: string, error: unknown): Promise<A2aTaskRecord | undefined> {
    const reason = error instanceof Error ? error.message : String(error);
    return this.#finishWithMessage(taskId, "TASK_STATE_FAILED", reason);
  }

  async reject(taskId: string, reason: string): Promise<A2aTaskRecord | undefined> {
    return this.#finishWithMessage(taskId, "TASK_STATE_REJECTED", reason);
  }

  wait(task: A2aTaskRecord, timeoutMs: number): Promise<A2aTaskRecord> {
    if (isTerminalTask(task)) {
      return Promise.resolve(task);
    }
    const taskId = task.id;
    const completed = createDeferred<A2aTaskRecord>();
    const waiters = this.#waiters.get(taskId) ?? new Set<A2aTaskWaiter>();
    waiters.add(completed.resolve);
    this.#waiters.set(taskId, waiters);
    return raceWithTimeout(completed.promise, timeoutMs, () => task).finally(() => {
      waiters.delete(completed.resolve);
      if (waiters.size === 0) {
        this.#waiters.delete(taskId);
      }
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const results = await Promise.allSettled(
      [...this.#tasks.values()].map((task) =>
        this.fail(task.id, "A2A channel stopped before completing the task"),
      ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
    this.#writes.clear();
    this.#starts.clear();
    this.#messageTasks.clear();
    this.#taskMessageKeys.clear();
    this.#terminalTasks.clear();
    this.#taskOwners.clear();
    this.#tasks.clear();
  }

  async #finishWithMessage(
    taskId: string,
    state: "TASK_STATE_FAILED" | "TASK_STATE_REJECTED",
    reason: string,
  ): Promise<A2aTaskRecord | undefined> {
    const task = this.#tasks.get(taskId);
    if (!task || isTerminalTask(task)) {
      return task;
    }
    const terminal = { ...task };
    terminal.status = {
      state,
      timestamp: new Date().toISOString(),
      message: createStatusMessage(task.contextId, reason),
    };
    return this.#finishTask(task, terminal);
  }

  #finishTask(task: A2aTaskRecord, terminal: A2aTaskRecord): Promise<A2aTaskRecord | undefined> {
    const existing = this.#writes.get(task.id);
    if (existing) {
      return existing;
    }
    const finishedAt = Date.now();
    // The keyed owner breaks same-millisecond eviction ties by key. Keep those
    // keys in finish order without changing the original completion time.
    this.#lastFinishKey = Math.max(finishedAt, this.#lastFinishKey + 1);
    const key = `${String(this.#lastFinishKey).padStart(16, "0")}:${task.id}`;
    // Unknown acknowledgements may have committed; retain their rejection so
    // dispatch/shutdown cannot overwrite a possibly durable answer.
    const write = (async () => {
      await this.#starts.get(task.id);
      let persisted = false;
      try {
        await this.terminalStore.register(
          key,
          {
            task: terminal,
            ownerPeer: this.#taskOwners.get(task.id)!,
            messageKey: this.#taskMessageKeys.get(task.id)!,
            finishedAt,
          },
          { ttlMs: Math.max(1, finishedAt + A2A_TERMINAL_RETENTION_MS - Date.now()) },
        );
        persisted = true;
      } catch (error) {
        if (!isDefiniteStorageRefusal(error)) {
          throw error;
        }
        // These errors prove the write was refused, not ambiguously committed.
        // Even an oversized deduplication key must leave an observable outcome.
        terminal.status = {
          state: "TASK_STATE_FAILED",
          timestamp: new Date().toISOString(),
          message: createStatusMessage(
            task.contextId,
            `A2A terminal result could not be stored; after a Gateway restart the outcome may be unknown (${error.code})`,
          ),
        };
      }
      if (persisted) {
        await this.#deletePending(task.id);
      }
      Object.assign(task, terminal);
      this.#terminalTasks.set(task.id, finishedAt);
      const waiters = this.#waiters.get(task.id);
      this.#waiters.delete(task.id);
      for (const resolve of waiters ?? []) {
        resolve(task);
      }
      this.#pruneTerminalTasks();
      return task;
    })();
    this.#writes.set(task.id, write);
    return write;
  }

  async #deletePending(taskId: string): Promise<void> {
    try {
      await this.pendingStore.delete(taskId);
    } catch (error) {
      // The terminal result already committed. Restart can retry this cleanup;
      // losing the answer to a cleanup error would conceal that known outcome.
      logError(`A2A pending task cleanup failed: ${String(error)}`);
    }
  }

  #deleteTask(taskId: string): void {
    const messageKey = this.#taskMessageKeys.get(taskId);
    if (messageKey !== undefined) {
      if (this.#messageTasks.get(messageKey)?.id === taskId) {
        this.#messageTasks.delete(messageKey);
      }
      this.#taskMessageKeys.delete(taskId);
    }
    this.#starts.delete(taskId);
    this.#writes.delete(taskId);
    this.#terminalTasks.delete(taskId);
    this.#taskOwners.delete(taskId);
    this.#tasks.delete(taskId);
  }

  #pruneTerminalTasks(): void {
    const expiresBefore = Date.now() - A2A_TERMINAL_RETENTION_MS;
    for (const [taskId, finishedAt] of this.#terminalTasks) {
      if (finishedAt > expiresBefore && this.#terminalTasks.size <= A2A_TERMINAL_MAX_TASKS) {
        break;
      }
      this.#deleteTask(taskId);
    }
  }
}
