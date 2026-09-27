import {
  captureAgentHarnessTaskAssignment,
  matchesAgentHarnessTaskAssignment,
  type AgentHarnessCompletionCustody,
  type AgentHarnessTaskAssignment,
  type AgentHarnessTaskRecord,
  type AgentHarnessTaskRuntime,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import {
  asFiniteNumber,
  normalizeOptionalString,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  codexNativeSubagentRunId,
  normalizeIdentifier,
  readNativeSubagentThreadIds,
  readThreadSpawnSource,
} from "./native-subagent-task-ids.js";
import type { CodexServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

type TaskLifecycleRuntime = Pick<
  AgentHarnessTaskRuntime,
  | "tryCreateRunningTaskRunAsync"
  | "recordTaskRunProgressByRunIdAsync"
  | "finalizeTaskRunByRunIdAsync"
  | "prepareTaskRecordsRead"
  | "prepareTaskRunRead"
  | "setDetachedTaskDeliveryStatusByRunIdAsync"
  | "assertTaskAssignmentSupported"
>;

type CodexNativeSubagentTaskMirrorParams = {
  parentThreadId: string;
  requesterSessionKey?: string;
  historyOwner?: CodexNativeSubagentHistoryOwner;
  agentId?: string;
  now?: () => number;
  onTaskCreated?: (assignment: AgentHarnessTaskAssignment) => void;
  getCompletionCustody?: (runId: string) => AgentHarnessCompletionCustody | undefined;
  onSettled?: () => void;
};

type TaskAssignment = { receipt: AgentHarnessTaskAssignment; created?: true };
type TaskRunSelection = { runId: string; assignment?: TaskAssignment };

const THREAD_PROGRESS = new Map([
  ["active", "Subagent is active."],
  ["idle", "Subagent is idle."],
  ["systemError", "Subagent hit a system error; awaiting recovery."],
  ["notLoaded", "Subagent is not loaded."],
]);
const COLLAB_STATUS_ALIASES = new Map([
  ["completed", "completed"],
  ["succeeded", "completed"],
  ["success", "completed"],
  ["failed", "failed"],
  ["error", "failed"],
  ["blocked", "blocked"],
  ["declined", "blocked"],
  ["inprogress", "running"],
  ["running", "running"],
]);

export class CodexNativeSubagentTaskMirror {
  // A rejected creation cannot accept status updates until creation is retried.
  private readonly mirrorStateByRunId = new Map<string, "mirrored" | "failed">();
  private readonly terminalRunIds = new Set<string>();
  private readonly authoritativeRunIds = new Set<string>();
  private readonly runIdsByThreadId = new Map<string, string>();
  private readonly assignments = new Map<string, TaskAssignment>();
  private readonly now: () => number;
  private pendingWrite: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private readonly taskCreations = new Map<
    string,
    { previousRunId: string; promise?: Promise<void> }
  >();

  constructor(
    private readonly params: CodexNativeSubagentTaskMirrorParams,
    private readonly runtime: TaskLifecycleRuntime,
  ) {
    this.now = params.now ?? Date.now;
  }

  get hasPendingWrites(): boolean {
    return this.pendingWrites > 0;
  }

  settlePendingWrites(): Promise<void> {
    return this.pendingWrite;
  }

  async drain(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.pendingWrite;
      await pending;
    } while (pending !== this.pendingWrite);
  }

  queueTaskEvent(emit: () => void | Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      await emit();
    });
  }

  enqueuePersistence(write: () => Promise<void>): Promise<void> {
    return this.enqueue(write);
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    this.pendingWrites += 1;
    const pending = this.pendingWrite.then(write, write).finally(() => {
      this.pendingWrites -= 1;
      this.params.onSettled?.();
    });
    this.pendingWrite = pending;
    return pending;
  }

  get supportsAsyncPersistence(): boolean {
    return Boolean(
      this.runtime.tryCreateRunningTaskRunAsync &&
      this.runtime.recordTaskRunProgressByRunIdAsync &&
      this.runtime.finalizeTaskRunByRunIdAsync &&
      this.runtime.prepareTaskRecordsRead &&
      this.runtime.prepareTaskRunRead &&
      this.runtime.setDetachedTaskDeliveryStatusByRunIdAsync &&
      this.runtime.assertTaskAssignmentSupported,
    );
  }

  assertSupported(): void {
    this.getRuntime();
  }

  private getRuntime() {
    const runtime = this.runtime;
    if (
      !runtime.tryCreateRunningTaskRunAsync ||
      !runtime.recordTaskRunProgressByRunIdAsync ||
      !runtime.finalizeTaskRunByRunIdAsync ||
      !runtime.prepareTaskRecordsRead ||
      !runtime.prepareTaskRunRead ||
      !runtime.setDetachedTaskDeliveryStatusByRunIdAsync ||
      !runtime.assertTaskAssignmentSupported
    ) {
      throw new Error(
        "Codex native task mirroring requires asynchronous exact-assignment persistence. Upgrade the OpenClaw host.",
      );
    }
    runtime.assertTaskAssignmentSupported();
    return {
      create: runtime.tryCreateRunningTaskRunAsync.bind(runtime),
      progress: runtime.recordTaskRunProgressByRunIdAsync.bind(runtime),
      finalize: runtime.finalizeTaskRunByRunIdAsync.bind(runtime),
      prepareRead: runtime.prepareTaskRecordsRead.bind(runtime),
    };
  }

  markAuthoritativeCompletion(childThreadId: string, runId = this.runId(childThreadId)): void {
    // A later assignment has its own run. Delayed events cannot rewrite this result.
    this.authoritativeRunIds.add(runId);
    this.terminalRunIds.add(runId);
  }

  restoreCurrentTaskRun(threadId: string, task: AgentHarnessTaskRecord): void {
    const runId = task.runId!;
    this.pinTaskAssignment(task);
    this.runIdsByThreadId.set(threadId, runId);
    this.mirrorStateByRunId.set(runId, "mirrored");
  }

  getTaskAssignment(runId: string): AgentHarnessTaskAssignment | undefined {
    return this.assignments.get(runId)?.receipt;
  }

  pinTaskAssignment(
    task: AgentHarnessTaskRecord | AgentHarnessTaskAssignment,
  ): AgentHarnessTaskAssignment {
    const existing = this.assignments.get(task.runId!);
    if (existing) {
      return existing.receipt;
    }
    const receipt = captureAgentHarnessTaskAssignment(task);
    this.assignments.set(receipt.runId, { receipt });
    return receipt;
  }

  advanceTaskAssignment(
    previous: AgentHarnessTaskAssignment,
    committed: AgentHarnessTaskAssignment,
  ): boolean {
    const current = this.assignments.get(previous.runId);
    if (!current || !matchesAgentHarnessTaskAssignment(current.receipt, previous)) {
      return false;
    }
    // Queued observations keep this assignment; only its own commit may advance the receipt.
    current.receipt = committed;
    return true;
  }

  private ownership(selection: TaskRunSelection) {
    const admitted = this.assignments.get(selection.runId);
    const expectedTask =
      selection.assignment?.receipt ?? (admitted?.created ? admitted.receipt : undefined);
    return expectedTask
      ? { expectedTask, completionCustody: this.params.getCompletionCustody?.(selection.runId) }
      : {};
  }

  waitForTaskCreation(runId: string): Promise<void> {
    return this.taskCreations.get(runId)?.promise ?? Promise.resolve();
  }

  startFollowupTurn(threadId: string, turnId: string, nativeParentThreadId: string): Promise<void> {
    const runtime = this.getRuntime();
    const runId = codexNativeSubagentRunId(threadId, turnId);
    const attempt = this.taskCreations.get(runId) ?? { previousRunId: this.runId(threadId) };
    if (attempt.promise) {
      return attempt.promise;
    }
    this.runIdsByThreadId.set(threadId, runId);
    const selection: TaskRunSelection = { runId, assignment: this.assignments.get(runId) };
    const creation = this.enqueue(async () => {
      const read = await runtime.prepareRead();
      const previous = read().find((task) => task.runId === attempt.previousRunId);
      const created = await this.createRunningTask({
        threadId,
        selection,
        turnId,
        nativeParentThreadId,
        label: previous?.label ?? "Subagent",
        task: previous?.task ?? "Subagent follow-up",
        startedAt: this.now(),
        progressSummary: "Subagent started follow-up work.",
      });
      if (!created && !this.assignments.has(runId)) {
        throw new Error("Codex native follow-up task creation did not persist.");
      }
    });
    attempt.promise = creation;
    this.taskCreations.set(runId, attempt);
    void creation.catch(() => {
      if (attempt.promise === creation) {
        attempt.promise = undefined;
      }
    });
    return creation;
  }

  recordNativeTurn(runId: string, turnId: string): Promise<void> {
    const runtime = this.getRuntime();
    const selection: TaskRunSelection = { runId, assignment: this.assignments.get(runId) };
    return this.enqueue(async () => {
      const ownership = this.ownership(selection);
      const read = await runtime.prepareRead();
      const task = read().find((record) => record.runId === runId);
      const detail = isJsonObject(task?.detail) ? task.detail : {};
      if (
        !task ||
        detail.nativeTurnId === turnId ||
        !ownership.expectedTask ||
        !matchesAgentHarnessTaskAssignment(task, ownership.expectedTask)
      ) {
        return;
      }
      await runtime.progress({
        runId,
        ...ownership,
        detail: { ...detail, nativeTurnId: turnId },
      });
    });
  }

  private runId(threadId: string): string {
    return this.runIdsByThreadId.get(threadId) ?? codexNativeSubagentRunId(threadId);
  }

  handleNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const item = isJsonObject(params?.item) ? params.item : undefined;
    const thread = isJsonObject(params?.thread) ? params.thread : undefined;
    const threadIds =
      notification.method === "thread/started"
        ? [readString(thread, "id")]
        : notification.method === "thread/status/changed"
          ? [readString(params, "threadId")]
          : item?.type === "subAgentActivity"
            ? [readString(item, "agentThreadId")]
            : item?.type === "collabAgentToolCall"
              ? [
                  ...readNativeSubagentThreadIds(item.receiverThreadIds),
                  ...readAgentsStates(item.agentsStates).keys(),
                ]
              : [];
    const selections = new Map<string, TaskRunSelection>();
    for (const value of threadIds) {
      const threadId = normalizeOptionalString(value);
      if (threadId) {
        const runId = this.runId(threadId);
        selections.set(threadId, { runId, assignment: this.assignments.get(runId) });
      }
    }
    return this.enqueue(() => this.mirrorNotification(notification, selections));
  }

  private async mirrorNotification(
    notification: CodexServerNotification,
    selections: ReadonlyMap<string, TaskRunSelection>,
  ): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    if (notification.method === "thread/started") {
      const thread = isJsonObject(params.thread) ? params.thread : undefined;
      const selection = selections.get(readString(thread, "id")?.trim() ?? "");
      if (selection) {
        await this.handleThreadStarted(params, selection);
      }
      return;
    }
    if (notification.method === "thread/status/changed") {
      const selection = selections.get(readString(params, "threadId")?.trim() ?? "");
      if (selection && isJsonObject(params.status)) {
        await this.applyStatus(selection, readString(params.status, "type"));
      }
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      if (
        notification.method === "item/completed" &&
        item &&
        readString(item, "type") === "subAgentActivity"
      ) {
        const selection = selections.get(readString(item, "agentThreadId")?.trim() ?? "");
        if (selection) {
          await this.handleSubagentActivityItem(params, selection);
        }
        return;
      }
      await this.handleCollabAgentItem(params, selections);
    }
  }

  private async handleThreadStarted(
    params: JsonObject,
    selection: TaskRunSelection,
  ): Promise<void> {
    const thread = params.thread;
    if (!isJsonObject(thread) || typeof thread.id !== "string") {
      return;
    }
    const spawn = readThreadSpawnSource(thread);
    if (!spawn || spawn.parent_thread_id !== this.params.parentThreadId) {
      return;
    }
    const threadId = thread.id.trim();
    const label =
      normalizeOptionalString(spawn.agent_nickname) ??
      normalizeOptionalString(thread.agentNickname) ??
      normalizeOptionalString(spawn.agent_role) ??
      normalizeOptionalString(thread.agentRole) ??
      "Subagent";
    const task =
      normalizeOptionalString(thread.preview) ??
      `Subagent${label === "Subagent" ? "" : ` ${label}`}`;
    const createdAt = asFiniteNumber(thread.createdAt);
    if (
      !(await this.createRunningTask({
        threadId,
        selection,
        label,
        task,
        startedAt: createdAt === undefined ? this.now() : createdAt * 1000,
        progressSummary: "Subagent started.",
      }))
    ) {
      return;
    }
    await this.applyStatus(
      selection,
      isJsonObject(thread.status) ? readString(thread.status, "type") : undefined,
    );
  }

  private async applyStatus(
    selection: TaskRunSelection,
    statusType: string | undefined,
  ): Promise<void> {
    const { runId } = selection;
    if (this.mirrorStateByRunId.get(runId) === "failed") {
      return;
    }
    if (!statusType) {
      return;
    }
    if (this.authoritativeRunIds.has(runId)) {
      return;
    }
    if (this.terminalRunIds.has(runId) && statusType !== "systemError") {
      return;
    }
    const progressSummary = THREAD_PROGRESS.get(statusType);
    if (!progressSummary) {
      return;
    }
    const ownership = this.ownership(selection);
    if (!ownership.expectedTask) {
      return;
    }
    const eventAt = this.now();
    if (statusType === "systemError") {
      this.terminalRunIds.delete(runId);
    }
    await this.getRuntime().progress({
      runId,
      ...ownership,
      lastEventAt: eventAt,
      progressSummary,
    });
  }

  private async handleCollabAgentItem(
    params: JsonObject,
    selections: ReadonlyMap<string, TaskRunSelection>,
  ): Promise<void> {
    const item = isJsonObject(params.item) ? params.item : undefined;
    if (!item || readString(item, "type") !== "collabAgentToolCall") {
      return;
    }
    const senderThreadId = readString(item, "senderThreadId") ?? readString(params, "threadId");
    if (senderThreadId !== this.params.parentThreadId) {
      return;
    }
    const tool = normalizeIdentifier(readString(item, "tool"));
    // Wait snapshots name a thread, not its assignment. Predecessor results
    // belong to delivery receipts and must not mutate the current task run.
    if (tool === "wait") {
      return;
    }
    const isSpawnAgentTool = tool === "spawnagent";
    const receiverThreadIds = readNativeSubagentThreadIds(item.receiverThreadIds);
    const agentsStates = readAgentsStates(item.agentsStates);
    const spawnChildThreadIds = new Set([...receiverThreadIds, ...agentsStates.keys()]);
    if (isSpawnAgentTool) {
      for (const childThreadId of spawnChildThreadIds) {
        const selection = selections.get(childThreadId.trim());
        if (!selection) {
          continue;
        }
        await this.createRunningTask({
          threadId: childThreadId,
          selection,
          label: "Subagent",
          task: normalizeOptionalString(readString(item, "prompt")) ?? "Subagent",
          startedAt: this.now(),
          progressSummary: "Subagent spawned.",
        });
      }
    }
    const toolCallStatus = normalizeCollabToolCallStatus(readString(item, "status"));
    const terminalToolCallThreadIds =
      isSpawnAgentTool && (toolCallStatus === "failed" || toolCallStatus === "blocked")
        ? spawnChildThreadIds
        : new Set<string>();
    const terminalAgentStateThreadIds = new Set<string>();
    for (const [threadId, state] of agentsStates) {
      const selection = selections.get(threadId.trim());
      if (!selection) {
        continue;
      }
      const normalizedStatus = normalizeAgentStateStatus(state.status);
      if (
        terminalToolCallThreadIds.has(threadId) &&
        isNonTerminalAgentStateStatus(normalizedStatus)
      ) {
        continue;
      }
      await this.applyCollabAgentStatus(selection, normalizedStatus, state.message);
      if (normalizedStatus !== undefined && !isNonTerminalAgentStateStatus(normalizedStatus)) {
        terminalAgentStateThreadIds.add(threadId);
      }
    }
    for (const threadId of terminalToolCallThreadIds) {
      if (terminalAgentStateThreadIds.has(threadId)) {
        continue;
      }
      const state = agentsStates.get(threadId);
      const selection = selections.get(threadId.trim());
      if (selection) {
        await this.applyCollabAgentStatus(selection, toolCallStatus, state?.message);
      }
    }
  }

  private async handleSubagentActivityItem(
    params: JsonObject,
    selection: TaskRunSelection,
  ): Promise<void> {
    const item = isJsonObject(params.item) ? params.item : undefined;
    if (
      !item ||
      readString(item, "type") !== "subAgentActivity" ||
      readString(params, "threadId") !== this.params.parentThreadId
    ) {
      return;
    }
    const threadId = normalizeOptionalString(readString(item, "agentThreadId"));
    const kind = normalizeSubagentActivityKind(readString(item, "kind"));
    if (!threadId || !kind) {
      return;
    }
    if (kind === "started") {
      const agentPath = normalizeOptionalString(readString(item, "agentPath"));
      await this.createRunningTask({
        threadId,
        selection,
        label: "Subagent",
        task: agentPath ? `Subagent ${agentPath}` : "Subagent",
        startedAt: this.now(),
        progressSummary: "Subagent started.",
      });
      return;
    }
    if (this.mirrorStateByRunId.get(selection.runId) !== "mirrored") {
      return;
    }
    const message =
      kind === "interacted" ? "Subagent received more input." : "Subagent was interrupted.";
    await this.applyCollabAgentStatus(
      selection,
      kind === "interacted" ? "running" : "interrupted",
      message,
    );
  }

  private async createRunningTask(params: {
    threadId: string;
    selection: TaskRunSelection;
    turnId?: string;
    nativeParentThreadId?: string;
    label: string;
    task: string;
    startedAt: number;
    progressSummary: string;
  }): Promise<boolean> {
    const threadId = params.threadId.trim();
    const { runId } = params.selection;
    if (!threadId || this.mirrorStateByRunId.get(runId) === "mirrored") {
      return false;
    }
    // Creation also refreshes existing metadata. Recovery must preserve the original locator,
    // including its absence on rows created before native history ownership was recorded.
    const historyOwner =
      this.params.historyOwner && params.nativeParentThreadId
        ? { ...this.params.historyOwner, parentThreadId: params.nativeParentThreadId }
        : this.params.historyOwner;
    const runtime = this.getRuntime();
    this.mirrorStateByRunId.set(runId, "failed");
    const read = await runtime.prepareRead();
    const existing = read().find((task) => task.runId === runId);
    const stampHistoryOwner = historyOwner && !existing;
    const detail = {
      ...(isJsonObject(existing?.detail) ? existing.detail : {}),
      ...(stampHistoryOwner ? { nativeHistory: { ...historyOwner } } : {}),
      ...(params.turnId ? { nativeTurnId: params.turnId } : {}),
    };
    const taskRecord = await runtime.create({
      sourceId: runId,
      agentId: this.params.agentId,
      runId,
      label: params.label,
      task: params.task,
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: params.startedAt,
      lastEventAt: this.now(),
      progressSummary: params.progressSummary,
      ...(stampHistoryOwner || params.turnId ? { detail } : {}),
    });
    if (!taskRecord) {
      this.mirrorStateByRunId.set(runId, "failed");
      return false;
    }
    this.mirrorStateByRunId.set(runId, "mirrored");
    // Publication observers may already have replaced the row. Pin the actual
    // admitted return value so later native producers cannot adopt that successor.
    const assignment = this.pinTaskAssignment(taskRecord);
    this.assignments.get(runId)!.created = true;
    this.params.onTaskCreated?.(assignment);
    return true;
  }

  private async applyCollabAgentStatus(
    selection: TaskRunSelection,
    status: string | undefined,
    message: string | undefined,
  ): Promise<void> {
    const { runId } = selection;
    if (this.mirrorStateByRunId.get(runId) === "failed") {
      return;
    }
    const normalizedStatus = normalizeAgentStateStatus(status);
    if (!normalizedStatus) {
      return;
    }
    const ownership = this.ownership(selection);
    if (!ownership.expectedTask) {
      return;
    }
    if (this.authoritativeRunIds.has(runId)) {
      return;
    }
    if (this.terminalRunIds.has(runId) && isNonTerminalAgentStateStatus(normalizedStatus)) {
      return;
    }
    const eventAt = this.now();
    const summary = normalizeOptionalString(message);
    const nonTerminal = isNonTerminalAgentStateStatus(normalizedStatus);
    if (!nonTerminal) {
      this.terminalRunIds.add(runId);
    }
    if (nonTerminal || normalizedStatus === "completed") {
      // Codex interrupted agents remain open and can resume; finalizing here
      // makes cancellation sticky and discards their later successful result.
      await this.getRuntime().progress({
        runId,
        ...ownership,
        lastEventAt: eventAt,
        progressSummary:
          summary ??
          (normalizedStatus === "completed"
            ? "Subagent completed."
            : normalizedStatus === "pendingInit"
              ? "Subagent is initializing."
              : normalizedStatus === "interrupted"
                ? "Subagent was interrupted."
                : "Subagent is running."),
      });
      return;
    }
    const blocked = normalizedStatus === "blocked";
    await this.getRuntime().finalize({
      runId,
      ...ownership,
      status: blocked ? "succeeded" : normalizedStatus === "shutdown" ? "cancelled" : "failed",
      endedAt: eventAt,
      lastEventAt: eventAt,
      ...(blocked
        ? { terminalOutcome: "blocked" as const }
        : { error: summary ?? `Subagent status: ${normalizedStatus}` }),
      progressSummary: summary ?? `Subagent ${normalizedStatus}.`,
      terminalSummary: summary ?? (blocked ? "Subagent blocked." : "Subagent did not complete."),
    });
  }
}

function readAgentsStates(
  value: JsonValue | undefined,
): Map<string, { status?: string; message?: string }> {
  const states = new Map<string, { status?: string; message?: string }>();
  if (!isJsonObject(value)) {
    return states;
  }
  for (const [threadId, rawState] of Object.entries(value)) {
    if (!isJsonObject(rawState)) {
      continue;
    }
    const status = readString(rawState, "status");
    const message = readString(rawState, "message");
    states.set(threadId, { status, message });
  }
  return states;
}

function normalizeSubagentActivityKind(value: string | undefined) {
  const key = value?.replace(/[^a-z]/giu, "").toLowerCase();
  return key === "started" || key === "interacted" || key === "interrupted" ? key : undefined;
}

function normalizeCollabToolCallStatus(value: string | undefined): string | undefined {
  const key = normalizeIdentifier(value);
  return key === "errored" ? "failed" : (COLLAB_STATUS_ALIASES.get(key ?? "") ?? value?.trim());
}

function isNonTerminalAgentStateStatus(value: string | undefined): boolean {
  return value === "pendingInit" || value === "running" || value === "interrupted";
}

function normalizeAgentStateStatus(value: string | undefined): string | undefined {
  const key = normalizeIdentifier(value);
  if (!key) {
    return undefined;
  }
  if (key === "pendinginit") {
    return "pendingInit";
  }
  if (key === "interrupted" || key === "cancelled" || key === "canceled" || key === "shutdown") {
    return key === "shutdown" ? "shutdown" : "interrupted";
  }
  return key === "systemerror" ? "failed" : (COLLAB_STATUS_ALIASES.get(key) ?? value?.trim());
}
