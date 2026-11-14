import { createHash, randomUUID } from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { logError } from "openclaw/plugin-sdk/logging-core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  SourceQuestionV1,
  SourceQuestionAnswerReceiptV1,
} from "openclaw/plugin-sdk/reply-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { A2aProtocolError, A2A_BUSINESS_INPUT_EXTENSION } from "./protocol.js";
import type { A2aMessageRecord, A2aTaskRecord } from "./protocol.js";

const A2A_TERMINAL_MAX_TASKS = 500;
const A2A_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const A2A_ERROR_MAX_LENGTH = 512;
const A2A_MAX_INPUT_RECEIPTS = 32;
const A2A_MAX_QUESTIONS = 16;

type InputReceipt = {
  messageKey: string;
  promptMessageId: string;
  answerDigest: string;
  result: SourceQuestionAnswerReceiptV1 | { status: "pending" };
};
type TaskInputState = { questions: number; receipts: InputReceipt[] };

type StoredTerminalTask = {
  task: A2aTaskRecord;
  ownerPeer: string;
  messageKey: string;
  finishedAt: number;
  input?: TaskInputState;
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
  readonly #inputs = new Map<string, TaskInputState>();
  readonly #questions = new Map<string, { question: SourceQuestionV1; messageId: string }>();
  readonly #inputWrites = new Map<string, Promise<void>>();
  readonly #terminalKeys = new Map<string, string>();
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
      this.#terminalKeys.set(task.id, key);
      if (value.input) {
        this.#inputs.set(task.id, value.input);
      }
    }
    this.#pruneTerminalTasks();
    // Expired terminal aliases must not compete with retained answer identities.
    for (const [taskId, input] of this.#inputs) {
      this.#restoreInput(this.#tasks.get(taskId)!, input);
    }
    // Failed cleanup can outlive terminal retention and a later use of the same
    // message ID. Retained results and the newest admission own replay identity.
    const pending = (await this.pendingStore.entries()).toSorted(
      (left, right) => right.createdAt - left.createdAt,
    );
    for (const { key, value } of pending) {
      const { task, ownerPeer, messageKey } = value;
      if (
        key !== task.id ||
        !["TASK_STATE_WORKING", "TASK_STATE_INPUT_REQUIRED"].includes(task.status.state)
      ) {
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
      this.#restoreInput(task, value.input);
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

  /** Publish only after native registration and durable Task admission. */
  async requireInput(taskId: string, question: SourceQuestionV1): Promise<void> {
    let refused: Error | undefined;
    await this.#updateInput(taskId, async (task, input) => {
      if (this.#stopped || isTerminalTask(task) || question.signal.aborted) {
        refused = new Error("A2A question source is no longer active");
        return;
      }
      if (input.questions >= A2A_MAX_QUESTIONS) {
        refused = new Error("A2A task reached its business question limit");
        return;
      }
      const message: A2aMessageRecord = {
        messageId: randomUUID(),
        taskId,
        contextId: task.contextId,
        role: "ROLE_AGENT",
        extensions: [A2A_BUSINESS_INPUT_EXTENSION],
        parts: [
          {
            text: question.questions
              .map(
                (item) =>
                  `${item.id}: ${item.question}\n${(item.options ?? []).map((option) => option.label).join(" / ")}`,
              )
              .join("\n\n"),
          },
          { data: { questions: question.questions } },
        ],
        metadata: {
          [A2A_BUSINESS_INPUT_EXTENSION]: {
            expiresAt: new Date(question.expiresAtMs).toISOString(),
          },
        },
      };
      const updated: A2aTaskRecord = {
        ...task,
        status: {
          state: "TASK_STATE_INPUT_REQUIRED",
          timestamp: new Date().toISOString(),
          message,
        },
      };
      const next = { ...input, questions: input.questions + 1 };
      await this.#persistInput(updated, next);
      this.#inputs.set(taskId, next);
      Object.assign(task, updated);
      if (question.signal.aborted || this.#stopped) {
        refused = new Error("A2A question expired during publication");
        return;
      }
      this.#questions.set(taskId, { question, messageId: message.messageId });
      this.#notify(task);
    });
    if (refused) {
      throw refused;
    }
  }

  /** A stable message ID owns one admission; uncertain writes never release it. */
  async beginAnswer(
    taskId: string,
    peer: string,
    messageId: string,
    promptMessageId: string,
    answerText: string,
  ): Promise<{
    task: A2aTaskRecord;
    question?: SourceQuestionV1;
    receipt: InputReceipt;
  }> {
    const task = this.get(taskId, peer);
    if (!task) {
      throw new A2aProtocolError(-32001, "Task not found");
    }
    const messageKey = JSON.stringify([peer, messageId]);
    const answerDigest = createHash("sha256").update(answerText).digest("hex");
    const known = this.#messageTasks.get(messageKey);
    if (known) {
      const receipt = this.#inputs
        .get(taskId)
        ?.receipts.find((item) => item.messageKey === messageKey);
      if (
        known !== task ||
        !receipt ||
        receipt.promptMessageId !== promptMessageId ||
        receipt.answerDigest !== answerDigest
      ) {
        throw new A2aProtocolError(
          -32602,
          "Message ID already belongs to a different task input or answer payload",
        );
      }
      await this.#inputWrites.get(taskId);
      return { task, receipt };
    }
    const current = this.#questions.get(taskId);
    if (
      this.#stopped ||
      task.status.state !== "TASK_STATE_INPUT_REQUIRED" ||
      !current ||
      current.messageId !== promptMessageId ||
      current.question.signal.aborted
    ) {
      throw new A2aProtocolError(
        -32602,
        "The referenced business question is no longer answerable",
      );
    }
    const input = this.#inputs.get(taskId)!;
    if (input.receipts.length >= A2A_MAX_INPUT_RECEIPTS) {
      throw new A2aProtocolError(-32000, "Task input receipt limit reached");
    }
    const receipt: InputReceipt = {
      messageKey,
      promptMessageId,
      answerDigest,
      result: { status: "pending" },
    };
    // Reserve synchronously before the first await so concurrent HTTP requests cannot dispatch twice.
    input.receipts.push(receipt);
    this.#messageTasks.set(messageKey, task);
    await this.#updateInput(taskId, async (currentTask, currentInput) => {
      await this.#persistInput(currentTask, currentInput);
    });
    return { task, question: current.question, receipt };
  }

  async recordAnswer(
    taskId: string,
    receipt: InputReceipt,
    result: SourceQuestionAnswerReceiptV1,
  ): Promise<void> {
    await this.#updateInput(taskId, async (task, input) => {
      if (!input.receipts.includes(receipt) || receipt.result.status !== "pending") {
        return;
      }
      receipt.result = result;
      const current = this.#questions.get(taskId);
      const updated =
        result.status === "confirmed" &&
        task.status.state === "TASK_STATE_INPUT_REQUIRED" &&
        current?.messageId === receipt.promptMessageId
          ? {
              ...task,
              status: { state: "TASK_STATE_WORKING" as const, timestamp: new Date().toISOString() },
            }
          : task;
      await this.#persistInput(updated, input);
      Object.assign(task, updated);
      if (result.status === "confirmed" && current?.messageId === receipt.promptMessageId) {
        this.#questions.delete(taskId);
      }
    });
  }

  #restoreInput(task: A2aTaskRecord, input: TaskInputState | undefined): void {
    if (!input) {
      return;
    }
    this.#inputs.set(task.id, input);
    for (const receipt of input.receipts) {
      // Retained results and newer admissions were restored before stale pending cleanup.
      if (!this.#messageTasks.has(receipt.messageKey)) {
        this.#messageTasks.set(receipt.messageKey, task);
      }
    }
  }

  #updateInput(
    taskId: string,
    update: (task: A2aTaskRecord, input: TaskInputState) => Promise<void>,
  ): Promise<void> {
    const previous = this.#inputWrites.get(taskId);
    const terminal = this.#writes.get(taskId);
    const write = (async () => {
      await previous;
      await terminal;
      await this.#starts.get(taskId);
      const task = this.#tasks.get(taskId);
      if (!task) {
        throw new Error("A2A task is no longer retained");
      }
      const input = this.#inputs.get(taskId) ?? { questions: 0, receipts: [] };
      await update(task, input);
    })();
    // An ambiguous acknowledgement fences later mutations until restore reconciles the owner.
    this.#inputWrites.set(taskId, write);
    return write;
  }

  async #persistInput(task: A2aTaskRecord, input: TaskInputState): Promise<void> {
    const value = {
      task,
      input,
      ownerPeer: this.#taskOwners.get(task.id)!,
      messageKey: this.#taskMessageKeys.get(task.id)!,
    };
    const finishedAt = this.#terminalTasks.get(task.id);
    if (finishedAt !== undefined) {
      await this.terminalStore.register(
        this.#terminalKeys.get(task.id)!,
        { ...value, finishedAt },
        { ttlMs: Math.max(1, finishedAt + A2A_TERMINAL_RETENTION_MS - Date.now()) },
      );
    } else {
      await this.pendingStore.register(task.id, value);
    }
  }

  #notify(task: A2aTaskRecord): void {
    const waiters = this.#waiters.get(task.id);
    this.#waiters.delete(task.id);
    for (const resolve of waiters ?? []) {
      resolve(task);
    }
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
    if (isTerminalTask(task) || task.status.state === "TASK_STATE_INPUT_REQUIRED") {
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
    this.#inputs.clear();
    this.#questions.clear();
    this.#inputWrites.clear();
    this.#terminalKeys.clear();
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
    const inputWrite = this.#inputWrites.get(task.id);
    const finishedAt = Date.now();
    // The keyed owner breaks same-millisecond eviction ties by key. Keep those
    // keys in finish order without changing the original completion time.
    this.#lastFinishKey = Math.max(finishedAt, this.#lastFinishKey + 1);
    const key = `${String(this.#lastFinishKey).padStart(16, "0")}:${task.id}`;
    // Unknown acknowledgements may have committed; retain their rejection so
    // dispatch/shutdown cannot overwrite a possibly durable answer.
    const write = (async () => {
      await this.#starts.get(task.id);
      await inputWrite;
      let persisted = false;
      try {
        await this.terminalStore.register(
          key,
          {
            task: terminal,
            ...(this.#inputs.has(task.id) ? { input: this.#inputs.get(task.id)! } : {}),
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
      this.#terminalKeys.set(task.id, key);
      this.#questions.delete(task.id);
      this.#notify(task);
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
    for (const receipt of this.#inputs.get(taskId)?.receipts ?? []) {
      if (this.#messageTasks.get(receipt.messageKey)?.id === taskId) {
        this.#messageTasks.delete(receipt.messageKey);
      }
    }
    this.#inputs.delete(taskId);
    this.#questions.delete(taskId);
    this.#inputWrites.delete(taskId);
    this.#terminalKeys.delete(taskId);
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
