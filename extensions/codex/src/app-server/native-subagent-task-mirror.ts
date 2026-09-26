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
  | "tryCreateRunningTaskRun"
  | "recordTaskRunProgressByRunId"
  | "finalizeTaskRunByRunId"
  | "listTaskRecords"
>;

type CodexNativeSubagentTaskMirrorParams = {
  parentThreadId: string;
  requesterSessionKey?: string;
  historyOwner?: CodexNativeSubagentHistoryOwner;
  agentId?: string;
  now?: () => number;
  onTaskCreated?: (assignment: AgentHarnessTaskAssignment) => void;
  getCompletionCustody?: (runId: string) => AgentHarnessCompletionCustody | undefined;
};

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
  // "failed" remembers a rejected task-run creation so later status events for
  // that thread stay silent; unknown threads still pass through by design.
  private readonly mirrorStateByThreadId = new Map<string, "mirrored" | "failed">();
  private readonly terminalRunIds = new Set<string>();
  private readonly authoritativeRunIds = new Set<string>();
  private readonly runIdsByThreadId = new Map<string, string>();
  private readonly assignments = new Map<string, AgentHarnessTaskAssignment>();
  private readonly now: () => number;

  constructor(
    private readonly params: CodexNativeSubagentTaskMirrorParams,
    private readonly runtime: TaskLifecycleRuntime,
  ) {
    this.now = params.now ?? Date.now;
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
    this.mirrorStateByThreadId.set(threadId, "mirrored");
  }

  getTaskAssignment(runId: string): AgentHarnessTaskAssignment | undefined {
    return this.assignments.get(runId);
  }

  pinTaskAssignment(
    task: AgentHarnessTaskRecord | AgentHarnessTaskAssignment,
  ): AgentHarnessTaskAssignment {
    const assignment = this.assignments.get(task.runId!) ?? captureAgentHarnessTaskAssignment(task);
    this.assignments.set(assignment.runId, assignment);
    return assignment;
  }

  advanceTaskAssignment(
    previous: AgentHarnessTaskAssignment,
    committed: AgentHarnessTaskAssignment,
  ): boolean {
    const current = this.assignments.get(previous.runId);
    if (!current || !matchesAgentHarnessTaskAssignment(current, previous)) {
      return false;
    }
    this.assignments.set(previous.runId, committed);
    return true;
  }

  private ownership(runId: string) {
    const expectedTask = this.assignments.get(runId);
    return expectedTask
      ? { expectedTask, completionCustody: this.params.getCompletionCustody?.(runId) }
      : {};
  }

  startFollowupTurn(threadId: string, turnId: string, nativeParentThreadId: string): void {
    const previousRunId = this.runId(threadId);
    const previous = this.runtime.listTaskRecords().find((task) => task.runId === previousRunId);
    const runId = codexNativeSubagentRunId(threadId, turnId);
    this.runIdsByThreadId.set(threadId, runId);
    this.mirrorStateByThreadId.delete(threadId);
    this.createRunningTask({
      threadId,
      turnId,
      nativeParentThreadId,
      label: previous?.label ?? "Subagent",
      task: previous?.task ?? "Subagent follow-up",
      startedAt: this.now(),
      progressSummary: "Subagent started follow-up work.",
    });
  }

  recordNativeTurn(runId: string, turnId: string): void {
    const task = this.runtime.listTaskRecords().find((record) => record.runId === runId);
    const detail = isJsonObject(task?.detail) ? task.detail : {};
    if (!task || detail.nativeTurnId === turnId) {
      return;
    }
    this.runtime.recordTaskRunProgressByRunId({
      runId,
      ...this.ownership(runId),
      detail: { ...detail, nativeTurnId: turnId },
    });
  }

  private runId(threadId: string): string {
    return this.runIdsByThreadId.get(threadId) ?? codexNativeSubagentRunId(threadId);
  }

  handleNotification(notification: CodexServerNotification): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    if (notification.method === "thread/started") {
      this.handleThreadStarted(params);
      return;
    }
    if (notification.method === "thread/status/changed") {
      this.handleThreadStatusChanged(params);
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      if (
        notification.method === "item/completed" &&
        item &&
        readString(item, "type") === "subAgentActivity"
      ) {
        this.handleSubagentActivityItem(params);
        return;
      }
      this.handleCollabAgentItem(params);
    }
  }

  private handleThreadStarted(params: JsonObject): void {
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
      !this.createRunningTask({
        threadId,
        label,
        task,
        startedAt: createdAt === undefined ? this.now() : createdAt * 1000,
        progressSummary: "Subagent started.",
      })
    ) {
      return;
    }
    this.applyStatus(
      threadId,
      isJsonObject(thread.status) ? readString(thread.status, "type") : undefined,
    );
  }

  private handleThreadStatusChanged(params: JsonObject): void {
    if (typeof params.threadId !== "string" || !isJsonObject(params.status)) {
      return;
    }
    this.applyStatus(params.threadId, readString(params.status, "type"));
  }

  private applyStatus(threadId: string, statusType: string | undefined): void {
    if (this.mirrorStateByThreadId.get(threadId) === "failed") {
      return;
    }
    if (!statusType) {
      return;
    }
    const runId = this.runId(threadId);
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
    const eventAt = this.now();
    if (statusType === "systemError") {
      this.terminalRunIds.delete(runId);
    }
    this.runtime.recordTaskRunProgressByRunId({
      runId,
      ...this.ownership(runId),
      lastEventAt: eventAt,
      progressSummary,
    });
  }

  private handleCollabAgentItem(params: JsonObject): void {
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
        this.createRunningTask({
          threadId: childThreadId,
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
      const normalizedStatus = normalizeAgentStateStatus(state.status);
      if (
        terminalToolCallThreadIds.has(threadId) &&
        isNonTerminalAgentStateStatus(normalizedStatus)
      ) {
        continue;
      }
      this.applyCollabAgentStatus(threadId, normalizedStatus, state.message);
      if (normalizedStatus !== undefined && !isNonTerminalAgentStateStatus(normalizedStatus)) {
        terminalAgentStateThreadIds.add(threadId);
      }
    }
    for (const threadId of terminalToolCallThreadIds) {
      if (terminalAgentStateThreadIds.has(threadId)) {
        continue;
      }
      const state = agentsStates.get(threadId);
      this.applyCollabAgentStatus(threadId, toolCallStatus, state?.message);
    }
  }

  private handleSubagentActivityItem(params: JsonObject): void {
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
      this.createRunningTask({
        threadId,
        label: "Subagent",
        task: agentPath ? `Subagent ${agentPath}` : "Subagent",
        startedAt: this.now(),
        progressSummary: "Subagent started.",
      });
      return;
    }
    if (this.mirrorStateByThreadId.get(threadId) !== "mirrored") {
      return;
    }
    const message =
      kind === "interacted" ? "Subagent received more input." : "Subagent was interrupted.";
    this.applyCollabAgentStatus(
      threadId,
      kind === "interacted" ? "running" : "interrupted",
      message,
    );
  }

  private createRunningTask(params: {
    threadId: string;
    turnId?: string;
    nativeParentThreadId?: string;
    label: string;
    task: string;
    startedAt: number;
    progressSummary: string;
  }): boolean {
    const threadId = params.threadId.trim();
    if (!threadId || this.mirrorStateByThreadId.get(threadId) === "mirrored") {
      return false;
    }
    this.mirrorStateByThreadId.set(threadId, "mirrored");
    const runId = this.runId(threadId);
    // Creation also refreshes existing metadata. Recovery must preserve the original locator,
    // including its absence on rows created before native history ownership was recorded.
    const historyOwner =
      this.params.historyOwner && params.nativeParentThreadId
        ? { ...this.params.historyOwner, parentThreadId: params.nativeParentThreadId }
        : this.params.historyOwner;
    const existing = this.runtime.listTaskRecords().find((task) => task.runId === runId);
    const stampHistoryOwner = historyOwner && !existing;
    const detail = {
      ...(isJsonObject(existing?.detail) ? existing.detail : {}),
      ...(stampHistoryOwner ? { nativeHistory: { ...historyOwner } } : {}),
      ...(params.turnId ? { nativeTurnId: params.turnId } : {}),
    };
    const taskRecord = this.runtime.tryCreateRunningTaskRun({
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
      this.mirrorStateByThreadId.set(threadId, "failed");
      return false;
    }
    this.terminalRunIds.delete(runId);
    this.authoritativeRunIds.delete(runId);
    // Publication observers may already have replaced the row. Pin the actual
    // admitted return value so later native producers cannot adopt that successor.
    const assignment = this.pinTaskAssignment(taskRecord);
    this.params.onTaskCreated?.(assignment);
    return true;
  }

  private applyCollabAgentStatus(
    threadId: string,
    status: string | undefined,
    message: string | undefined,
  ): void {
    if (this.mirrorStateByThreadId.get(threadId) === "failed") {
      return;
    }
    const normalizedStatus = normalizeAgentStateStatus(status);
    if (!normalizedStatus) {
      return;
    }
    const runId = this.runId(threadId);
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
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        ...this.ownership(runId),
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
    this.runtime.finalizeTaskRunByRunId({
      runId,
      ...this.ownership(runId),
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
