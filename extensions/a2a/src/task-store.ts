import { randomUUID } from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { taskNotFound, taskNotCancelable } from "./a2a-errors.js";
import {
  A2A_ROLES,
  A2A_TASK_STATES,
  isInterruptedTaskState,
  isTerminalTaskState,
  type A2aArtifact,
  type A2aMessage,
  type A2aPart,
  type A2aStreamResponse,
  type A2aTask,
  type A2aTaskArtifactUpdateEvent,
  type A2aTaskState,
} from "./a2a-model.js";

const A2A_TERMINAL_MAX_TASKS = 500;
const A2A_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const A2A_ERROR_MAX_LENGTH = 512;
const A2A_DEFAULT_PAGE_SIZE = 50;
const A2A_MAX_PAGE_SIZE = 100;
/**
 * Upper bound on buffered frames for a task that has no subscriber yet.
 *
 * Task creation reserves the mailbox before dispatch so a stream opened a tick
 * later still replays everything. This cap keeps a runaway task from growing
 * that buffer without bound; hitting it only costs a lagging subscriber the
 * oldest intermediate updates, because each frame's successor carries the
 * current state.
 */
const A2A_MAX_BUFFERED_EVENTS = 256;

export type A2aMessageRecord = A2aMessage;
export type A2aTaskRecord = A2aTask;
export type { A2aArtifact, A2aPart, A2aStreamResponse, A2aTaskState };

type A2aTaskWaiter = (task: A2aTask) => void;

/**
 * Per-task stream mailbox. `waiters` are resolved on every publish and again on
 * close so a parked consumer always re-checks `closed` and exits.
 */
type A2aTaskEventQueue = {
  events: A2aStreamResponse[];
  waiters: Set<() => void>;
  closed: boolean;
};

export type A2aTaskEventObserver = (params: {
  task: A2aTask;
  event: A2aStreamResponse;
  /** Peer that owns the task, so notifications stay scoped to one peer. */
  ownerPeer: string | undefined;
}) => void;

/**
 * Fired when a terminal task is evicted from retention, so stores keyed by
 * task (e.g. push notification registrations) can expire with their task.
 */
export type A2aTaskEvictionObserver = (params: {
  taskId: string;
  ownerPeer: string | undefined;
}) => void;

function cloneTask(task: A2aTask): A2aTask {
  return structuredClone(task);
}

function createStatusMessage(contextId: string, text: string): A2aMessage {
  return {
    messageId: randomUUID(),
    contextId,
    role: A2A_ROLES.AGENT,
    parts: [{ text: truncateUtf16Safe(text, A2A_ERROR_MAX_LENGTH) }],
  };
}

export class A2aTaskStore {
  readonly #tasks = new Map<string, A2aTask>();
  readonly #taskOwners = new Map<string, string>();
  readonly #messageTasks = new Map<string, A2aTask>();
  readonly #taskMessageKeys = new Map<string, string>();
  readonly #terminalTasks = new Map<string, number>();
  readonly #waiters = new Map<string, Set<A2aTaskWaiter>>();
  /**
   * One queue per subscriber, not per task: concurrent `SendStreamingMessage`
   * and `SubscribeToTask` streams each consume the full event sequence, so a
   * shared queue would let one subscriber steal frames from the other.
   */
  readonly #queues = new Map<string, Set<A2aTaskEventQueue>>();
  /**
   * Replay buffer per task, kept from creation so a subscriber that arrives a
   * tick late still sees every transition since `submitted`. Each new queue is
   * seeded with a copy; live events then flow into the buffer and every live
   * queue alike.
   */
  readonly #replayBuffers = new Map<string, A2aStreamResponse[]>();
  readonly #observers = new Set<A2aTaskEventObserver>();
  readonly #evictionObservers = new Set<A2aTaskEvictionObserver>();

  create(contextId: string, ownerPeer?: string, messageId?: string): A2aTask {
    this.#pruneTerminalTasks();
    const messageKey = messageId === undefined ? undefined : JSON.stringify([ownerPeer, messageId]);
    const existing = messageKey === undefined ? undefined : this.#messageTasks.get(messageKey);
    if (existing) {
      return existing;
    }
    const task: A2aTask = {
      id: randomUUID(),
      contextId,
      status: { state: A2A_TASK_STATES.SUBMITTED, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
    };
    this.#tasks.set(task.id, task);
    // Reserve the replay buffer before any work can publish, so a stream
    // opened after dispatch still replays every event the task produced.
    this.#replayBuffers.set(task.id, []);
    if (ownerPeer !== undefined) {
      this.#taskOwners.set(task.id, ownerPeer);
    }
    if (messageKey !== undefined) {
      this.#messageTasks.set(messageKey, task);
      this.#taskMessageKeys.set(task.id, messageKey);
    }
    return task;
  }

  get(taskId: string, ownerPeer?: string): A2aTask | undefined {
    this.#pruneTerminalTasks();
    if (ownerPeer !== undefined && this.#taskOwners.get(taskId) !== ownerPeer) {
      return undefined;
    }
    return this.#tasks.get(taskId);
  }

  /** Record a message in the task's conversation history (spec §4.2 `Task.history`). */
  appendHistory(taskId: string, message: A2aMessage): A2aTask | undefined {
    const task = this.#tasks.get(taskId);
    if (!task) {
      return undefined;
    }
    task.history.push(message);
    return task;
  }

  start(taskId: string): A2aTask | undefined {
    const task = this.#tasks.get(taskId);
    if (task?.status.state !== A2A_TASK_STATES.SUBMITTED) {
      return undefined;
    }
    this.#setStatus(task, A2A_TASK_STATES.WORKING);
    return task;
  }

  /** Move an interrupted task back to `working` when the peer answers the request. */
  resume(taskId: string): A2aTask | undefined {
    const task = this.#tasks.get(taskId);
    if (!task || !isInterruptedTaskState(task.status.state)) {
      return undefined;
    }
    this.#setStatus(task, A2A_TASK_STATES.WORKING);
    return task;
  }

  complete(taskId: string, text: string | undefined): A2aTask | undefined {
    const task = this.#tasks.get(taskId);
    if (!task || isTerminalTaskState(task.status.state)) {
      return task;
    }
    if (text?.trim()) {
      this.#addArtifact(task, { artifactId: randomUUID(), parts: [{ text }] }, true);
      task.history.push({
        messageId: randomUUID(),
        contextId: task.contextId,
        taskId: task.id,
        role: A2A_ROLES.AGENT,
        parts: [{ text }],
      });
    }
    task.status = {
      state: A2A_TASK_STATES.COMPLETED,
      timestamp: new Date().toISOString(),
      ...(!text?.trim()
        ? { message: createStatusMessage(task.contextId, "Agent completed without reply text") }
        : {}),
    };
    return this.#finishTask(task);
  }

  fail(taskId: string, error: unknown): A2aTask | undefined {
    const reason = error instanceof Error ? error.message : String(error);
    return this.#finishWithMessage(taskId, A2A_TASK_STATES.FAILED, reason);
  }

  reject(taskId: string, reason: string): A2aTask | undefined {
    return this.#finishWithMessage(taskId, A2A_TASK_STATES.REJECTED, reason);
  }

  /**
   * Cancel a task (spec §3.1.5). The A2A-visible task becomes terminal at once
   * and any blocking `SendMessage` returns; a late reply from the agent run is
   * discarded because terminal states are immutable.
   */
  cancel(taskId: string, ownerPeer?: string): A2aTask {
    const task = this.get(taskId, ownerPeer);
    if (!task) {
      throw taskNotFound("Task not found", taskId);
    }
    if (isTerminalTaskState(task.status.state)) {
      throw taskNotCancelable(
        `Task is already in terminal state ${task.status.state} and cannot be canceled`,
      );
    }
    task.status = {
      state: A2A_TASK_STATES.CANCELED,
      timestamp: new Date().toISOString(),
      message: createStatusMessage(task.contextId, "Task canceled by peer request"),
    };
    return this.#finishTask(task);
  }

  /** Enter `input-required` (spec §3.1.8): the task pauses for a follow-up message. */
  requireInput(taskId: string, reason: string): A2aTask | undefined {
    return this.#interrupt(taskId, A2A_TASK_STATES.INPUT_REQUIRED, reason);
  }

  /** Enter `auth-required` (spec §7.6): the task pauses for authorization. */
  requireAuth(taskId: string, reason: string): A2aTask | undefined {
    return this.#interrupt(taskId, A2A_TASK_STATES.AUTH_REQUIRED, reason);
  }

  wait(task: A2aTask, timeoutMs: number): Promise<A2aTask> {
    // Interrupted states resolve immediately too: the task is waiting on the
    // peer, so holding the response open would hide the question it must answer.
    if (isTerminalTaskState(task.status.state) || isInterruptedTaskState(task.status.state)) {
      return Promise.resolve(task);
    }
    const taskId = task.id;
    const completed = createDeferred<A2aTask>();
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

  /**
   * Stream task updates (spec §3.1.2 / §3.1.6).
   *
   * The first frame is the current Task snapshot while the task is live —
   * that is what prevents a peer from missing an update between `GetTask`
   * and subscribing. A terminal task with buffered history replays those
   * events instead: a completed-task snapshot (e.g. a `messageId` reuse
   * landing on an existing task) yielded before them would regress the
   * state sequence (spec §3.5.2, events in generation order). The stream
   * ends once the task reaches a terminal state.
   */
  async *stream(
    taskId: string,
    ownerPeer?: string,
    options: { timeoutMs?: number } = {},
  ): AsyncGenerator<A2aStreamResponse> {
    const task = this.get(taskId, ownerPeer);
    if (!task) {
      throw taskNotFound("Task not found", taskId);
    }
    // Subscribe before the first yield: an event published while the first
    // frame is in flight must land in this queue, not be missed. The queue is
    // seeded with the replay buffer so a late subscriber still observes every
    // transition since `submitted`.
    const replay = [...(this.#replayBuffers.get(taskId) ?? [])];
    const queue: A2aTaskEventQueue = {
      events: replay,
      waiters: new Set(),
      closed: false,
    };
    this.#subscribeQueue(taskId, queue);
    try {
      // A terminal-task snapshot yielded ahead of the replayed events would
      // regress the state sequence (STREAM-ORDER-001): the buffer still
      // holds the earlier `working` transitions. A live task's snapshot
      // cannot regress — `submitted` is never published, and the interrupted
      // states share the working order — so it stays the first frame.
      if (replay.length === 0 || !isTerminalTaskState(task.status.state)) {
        yield { task: cloneTask(task) };
      }
      // A task that never settles must not pin an HTTP response open forever. The
      // deadline bounds one stream; the peer can reconnect with SubscribeToTask.
      const deadline =
        options.timeoutMs !== undefined && options.timeoutMs > 0
          ? Date.now() + options.timeoutMs
          : undefined;
      while (true) {
        const next = queue.events.shift();
        if (next) {
          yield next;
          continue;
        }
        if (queue.closed) {
          return;
        }
        const current = this.#tasks.get(taskId);
        if (current && isTerminalTaskState(current.status.state)) {
          return;
        }
        if (deadline === undefined) {
          await this.#awaitEvent(queue);
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return;
        }
        await raceWithTimeout(this.#awaitEvent(queue), remaining, () => undefined);
      }
    } finally {
      // A consumer that stops iterating (client disconnect) releases its own
      // queue; other subscribers keep theirs.
      this.#unsubscribeQueue(taskId, queue);
    }
  }

  /** Observe every task event, for push-notification delivery. */
  onEvent(observer: A2aTaskEventObserver): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  /** Observe task evictions, so task-keyed stores expire with their tasks. */
  onTaskEvicted(observer: A2aTaskEvictionObserver): () => void {
    this.#evictionObservers.add(observer);
    return () => {
      this.#evictionObservers.delete(observer);
    };
  }

  listTasks(params: {
    ownerPeer: string;
    contextId?: string;
    status?: A2aTaskState;
    statusTimestampAfter?: string;
    pageSize?: number;
    pageToken?: string;
    historyLength?: number;
    includeArtifacts?: boolean;
  }): { tasks: A2aTask[]; nextPageToken: string; pageSize: number; totalSize: number } {
    this.#pruneTerminalTasks();
    const matches: A2aTask[] = [];
    for (const [taskId, task] of this.#tasks) {
      if (this.#taskOwners.get(taskId) !== params.ownerPeer) {
        continue;
      }
      if (params.contextId !== undefined && task.contextId !== params.contextId) {
        continue;
      }
      if (params.status !== undefined && task.status.state !== params.status) {
        continue;
      }
      // RFC 3339 timestamps compare correctly as strings when both sides use
      // the same `toISOString()` rendering.
      if (
        params.statusTimestampAfter !== undefined &&
        (task.status.timestamp ?? "") <= params.statusTimestampAfter
      ) {
        continue;
      }
      matches.push(task);
    }

    const requestedSize = params.pageSize ?? A2A_DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(
      Math.max(Math.trunc(requestedSize) || A2A_DEFAULT_PAGE_SIZE, 1),
      A2A_MAX_PAGE_SIZE,
    );
    // The cursor is the last id the caller already saw, so the next page starts
    // immediately after it. Using the first *unseen* id instead would skip it.
    const startIndex = params.pageToken
      ? matches.findIndex((task) => task.id === params.pageToken) + 1
      : 0;
    const safeStart = Math.max(startIndex, 0);
    const page = matches.slice(safeStart, safeStart + pageSize);
    const lastIncluded = page.at(-1);
    const hasMore = safeStart + pageSize < matches.length;

    return {
      tasks: page.map((task) => projectTask(task, params.historyLength, params.includeArtifacts)),
      nextPageToken: hasMore && lastIncluded ? lastIncluded.id : "",
      pageSize: page.length,
      totalSize: matches.length,
    };
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
    for (const subscribers of this.#queues.values()) {
      for (const queue of subscribers) {
        queue.closed = true;
        this.#notifyWaiters(queue);
      }
    }
    this.#queues.clear();
    this.#replayBuffers.clear();
    this.#waiters.clear();
  }

  #interrupt(taskId: string, state: A2aTaskState, reason: string): A2aTask | undefined {
    const task = this.#tasks.get(taskId);
    if (!task || isTerminalTaskState(task.status.state)) {
      return task;
    }
    const message = createStatusMessage(task.contextId, reason);
    task.status = { state, timestamp: new Date().toISOString(), message };
    task.history.push(message);
    // A blocking SendMessage must return once the task pauses for input: the
    // peer needs the question before it can continue (spec §3.1.8 / §7.6).
    const waiters = this.#waiters.get(task.id);
    if (waiters) {
      this.#waiters.delete(task.id);
      for (const resolve of waiters) {
        resolve(task);
      }
    }
    // Interrupted tasks keep their stream open: the peer needs the update, and it
    // may resume the same task with another message.
    this.#publish(task, {
      statusUpdate: {
        taskId: task.id,
        contextId: task.contextId,
        status: cloneTask(task).status,
      },
    });
    return task;
  }

  #finishWithMessage(taskId: string, state: A2aTaskState, reason: string): A2aTask | undefined {
    const task = this.#tasks.get(taskId);
    if (!task || isTerminalTaskState(task.status.state)) {
      return task;
    }
    const message = createStatusMessage(task.contextId, reason);
    task.status = {
      state,
      timestamp: new Date().toISOString(),
      message,
    };
    return this.#finishTask(task);
  }

  #finishTask(task: A2aTask): A2aTask {
    this.#terminalTasks.set(task.id, Date.now());
    const waiters = this.#waiters.get(task.id);
    if (waiters) {
      this.#waiters.delete(task.id);
      for (const resolve of waiters) {
        resolve(task);
      }
    }
    // Terminal status update must land before the mailbox closes, otherwise a
    // subscriber could see the stream end without ever seeing the final state.
    this.#publish(task, {
      statusUpdate: {
        taskId: task.id,
        contextId: task.contextId,
        status: cloneTask(task).status,
      },
    });
    this.#closeQueue(task.id);
    this.#pruneTerminalTasks();
    return task;
  }

  #setStatus(task: A2aTask, state: A2aTaskState): void {
    task.status = { state, timestamp: new Date().toISOString() };
    this.#publish(task, {
      statusUpdate: {
        taskId: task.id,
        contextId: task.contextId,
        status: cloneTask(task).status,
      },
    });
  }

  #addArtifact(task: A2aTask, artifact: A2aArtifact, lastChunk: boolean): void {
    task.artifacts = [
      ...task.artifacts.filter((entry) => entry.artifactId !== artifact.artifactId),
      artifact,
    ];
    const event: A2aTaskArtifactUpdateEvent = {
      taskId: task.id,
      contextId: task.contextId,
      artifact: structuredClone(artifact),
      ...(lastChunk ? { lastChunk: true } : {}),
    };
    this.#publish(task, { artifactUpdate: event });
  }

  #publish(task: A2aTask, event: A2aStreamResponse): void {
    const replay = this.#replayBuffers.get(task.id);
    if (replay) {
      replay.push(event);
      if (replay.length > A2A_MAX_BUFFERED_EVENTS) {
        replay.splice(0, replay.length - A2A_MAX_BUFFERED_EVENTS);
      }
    }
    const subscribers = this.#queues.get(task.id);
    if (subscribers) {
      for (const queue of subscribers) {
        if (queue.closed) {
          continue;
        }
        queue.events.push(event);
        if (queue.events.length > A2A_MAX_BUFFERED_EVENTS) {
          queue.events.splice(0, queue.events.length - A2A_MAX_BUFFERED_EVENTS);
        }
        this.#notifyWaiters(queue);
      }
    }
    const ownerPeer = this.#taskOwners.get(task.id);
    for (const observer of this.#observers) {
      try {
        observer({ task, event, ownerPeer });
      } catch {
        // A push delivery failure must never break task state transitions.
      }
    }
  }

  #subscribeQueue(taskId: string, queue: A2aTaskEventQueue): void {
    const subscribers = this.#queues.get(taskId) ?? new Set<A2aTaskEventQueue>();
    subscribers.add(queue);
    this.#queues.set(taskId, subscribers);
  }

  #unsubscribeQueue(taskId: string, queue: A2aTaskEventQueue): void {
    const subscribers = this.#queues.get(taskId);
    if (!subscribers) {
      return;
    }
    subscribers.delete(queue);
    // The task entry stays as long as any subscriber remains or the task is
    // still live; terminal tasks drop theirs in #pruneTerminalTasks.
    if (subscribers.size === 0 && !this.#tasks.has(taskId)) {
      this.#queues.delete(taskId);
    }
  }

  #closeQueue(taskId: string): void {
    const subscribers = this.#queues.get(taskId);
    if (!subscribers) {
      return;
    }
    for (const queue of subscribers) {
      queue.closed = true;
      this.#notifyWaiters(queue);
    }
  }

  #notifyWaiters(queue: A2aTaskEventQueue): void {
    const waiters = [...queue.waiters];
    queue.waiters.clear();
    for (const wake of waiters) {
      wake();
    }
  }

  #awaitEvent(queue: A2aTaskEventQueue): Promise<void> {
    return new Promise<void>((resolve) => {
      queue.waiters.add(resolve);
    });
  }

  #pruneTerminalTasks(): void {
    const expiresBefore = Date.now() - A2A_TERMINAL_RETENTION_MS;
    for (const [taskId, finishedAt] of this.#terminalTasks) {
      if (finishedAt > expiresBefore && this.#terminalTasks.size <= A2A_TERMINAL_MAX_TASKS) {
        break;
      }
      const ownerPeer = this.#taskOwners.get(taskId);
      const messageKey = this.#taskMessageKeys.get(taskId);
      if (messageKey !== undefined) {
        this.#messageTasks.delete(messageKey);
        this.#taskMessageKeys.delete(taskId);
      }
      this.#queues.delete(taskId);
      this.#replayBuffers.delete(taskId);
      this.#terminalTasks.delete(taskId);
      this.#taskOwners.delete(taskId);
      this.#tasks.delete(taskId);
      // Task-keyed stores (e.g. push notification registrations) must expire
      // with their task, or they leak webhooks for tasks that no longer exist.
      for (const observer of this.#evictionObservers) {
        try {
          observer({ taskId, ownerPeer });
        } catch {
          // Eviction observers must never break retention pruning.
        }
      }
    }
  }
}

/**
 * Apply `historyLength` / `includeArtifacts` projections (spec §3.1.4).
 *
 * Both are additive to the stored record, so the projection clones rather than
 * mutating: the same task may be listed twice with different projections.
 */
export function projectTask(
  task: A2aTask,
  historyLength?: number,
  includeArtifacts = false,
): A2aTask {
  const projected = cloneTask(task);
  if (!includeArtifacts) {
    projected.artifacts = [];
  }
  if (historyLength !== undefined) {
    if (historyLength === 0) {
      projected.history = [];
    } else if (projected.history.length > historyLength) {
      projected.history = projected.history.slice(-historyLength);
    }
  }
  return projected;
}
