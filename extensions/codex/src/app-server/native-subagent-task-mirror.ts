/**
 * Mirrors Codex native subagent thread lifecycle events into OpenClaw task
 * runtime rows so parent sessions can observe child progress.
 */
import type { AgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import {
  normalizeOptionalString,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  codexNativeSubagentRunId,
  readNativeSubagentThreadIds,
} from "./native-subagent-task-ids.js";
import type {
  CodexServerNotification,
  CodexSessionSource,
  CodexSubAgentThreadSpawnSource,
  CodexThread,
  CodexThreadStartedNotification,
  CodexThreadStatus,
  CodexThreadStatusChangedNotification,
  JsonObject,
  JsonValue,
} from "./protocol.js";
import { isJsonObject } from "./protocol.js";

/** Minimal task-runtime surface needed to mirror native subagent lifecycle. */
type TaskLifecycleRuntime = Pick<
  AgentHarnessTaskRuntime,
  | "tryCreateRunningTaskRun"
  | "recordTaskRunProgressByRunId"
  | "finalizeTaskRunByRunId"
  | "listTaskRecords"
>;

/** Stable parent/session context used while mirroring native subagent tasks. */
type CodexNativeSubagentTaskMirrorParams = {
  parentThreadId: string;
  requesterSessionKey?: string;
  historyOwner?: CodexNativeSubagentHistoryOwner;
  agentId?: string;
  now?: () => number;
};

/** Projects Codex thread and collab-agent notifications into task lifecycle updates. */
export class CodexNativeSubagentTaskMirror {
  // "failed" remembers a rejected task-run creation so later status events for
  // that thread stay silent; unknown threads still pass through by design.
  private readonly mirrorStateByThreadId = new Map<string, "mirrored" | "failed">();
  private readonly terminalRunIds = new Set<string>();
  private readonly authoritativeRunIds = new Set<string>();
  private readonly runIdsByThreadId = new Map<string, string>();
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

  restoreCurrentTaskRun(threadId: string, runId: string): void {
    this.runIdsByThreadId.set(threadId, runId);
    this.mirrorStateByThreadId.set(threadId, "mirrored");
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
    this.runtime.tryCreateRunningTaskRun({
      runId,
      sourceId: task.sourceId,
      label: task.label,
      task: task.task,
      notifyPolicy: task.notifyPolicy,
      deliveryStatus: task.deliveryStatus,
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
    const notification = readThreadStartedNotification(params);
    if (!notification) {
      return;
    }
    const thread = notification.thread;
    const spawn = readSubagentThreadSpawnSource(thread.source, this.params.parentThreadId);
    if (!spawn) {
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
    const createdAt = secondsToMillis(thread.createdAt) ?? this.now();
    if (
      !this.createRunningTask({
        threadId,
        label,
        task,
        startedAt: createdAt,
        progressSummary: "Subagent started.",
      })
    ) {
      return;
    }
    this.applyStatus(threadId, thread.status);
  }

  private handleThreadStatusChanged(params: JsonObject): void {
    const notification = readThreadStatusChangedNotification(params);
    if (!notification) {
      return;
    }
    this.applyStatus(notification.threadId, notification.status);
  }

  private applyStatus(threadId: string, status: CodexThreadStatus | null | undefined): void {
    if (this.mirrorStateByThreadId.get(threadId) === "failed") {
      return;
    }
    const statusType = status?.type;
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
    const eventAt = this.now();
    if (statusType === "active") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        lastEventAt: eventAt,
        progressSummary: "Subagent is active.",
      });
      return;
    }
    if (statusType === "idle") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        lastEventAt: eventAt,
        progressSummary: "Subagent is idle.",
      });
      return;
    }
    if (statusType === "systemError") {
      this.terminalRunIds.delete(runId);
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        lastEventAt: eventAt,
        progressSummary: "Subagent hit a system error; awaiting recovery.",
      });
      return;
    }
    if (statusType === "notLoaded") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        lastEventAt: eventAt,
        progressSummary: "Subagent is not loaded.",
      });
    }
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
    const isSpawnAgentTool = normalizeToolName(readString(item, "tool")) === "spawnagent";
    const receiverThreadIds = readNativeSubagentThreadIds(item.receiverThreadIds);
    const agentsStates = readAgentsStates(item.agentsStates);
    const spawnChildThreadIds = new Set([...receiverThreadIds, ...agentsStates.keys()]);
    if (isSpawnAgentTool) {
      for (const childThreadId of spawnChildThreadIds) {
        this.createTaskFromCollabSpawnItem(childThreadId, item);
      }
    }
    const toolCallStatus = normalizeCollabToolCallStatus(readString(item, "status"));
    const terminalToolCallThreadIds = new Set<string>();
    if (isSpawnAgentTool && isBlockedOrFailedCollabToolCallStatus(toolCallStatus)) {
      for (const threadId of spawnChildThreadIds) {
        terminalToolCallThreadIds.add(threadId);
      }
      for (const threadId of agentsStates.keys()) {
        terminalToolCallThreadIds.add(threadId);
      }
    }
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
      if (isTerminalAgentStateStatus(normalizedStatus)) {
        terminalAgentStateThreadIds.add(threadId);
      }
    }
    if (isBlockedOrFailedCollabToolCallStatus(toolCallStatus)) {
      for (const threadId of terminalToolCallThreadIds) {
        if (terminalAgentStateThreadIds.has(threadId)) {
          continue;
        }
        const state = agentsStates.get(threadId);
        this.applyCollabAgentStatus(threadId, toolCallStatus, state?.message);
      }
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
      this.createTaskFromSubagentActivity(
        threadId,
        normalizeOptionalString(readString(item, "agentPath")),
      );
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

  private createTaskFromSubagentActivity(threadId: string, agentPath: string | undefined): void {
    const eventAt = this.now();
    this.createRunningTask({
      threadId,
      label: "Subagent",
      task: agentPath ? `Subagent ${agentPath}` : "Subagent",
      startedAt: eventAt,
      progressSummary: "Subagent started.",
    });
  }

  private createTaskFromCollabSpawnItem(threadId: string, item: JsonObject): void {
    const prompt = normalizeOptionalString(readString(item, "prompt"));
    const createdAt = this.now();
    this.createRunningTask({
      threadId,
      label: "Subagent",
      task: prompt ?? "Subagent",
      startedAt: createdAt,
      progressSummary: "Subagent spawned.",
    });
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
    return true;
  }

  private applyCollabAgentStatus(
    threadId: string,
    status: string | undefined,
    message: string | null | undefined,
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
    if (isNonTerminalAgentStateStatus(normalizedStatus)) {
      // Codex interrupted agents remain open and can resume; finalizing here
      // makes cancellation sticky and discards their later successful result.
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        lastEventAt: eventAt,
        progressSummary:
          normalizeOptionalString(message) ??
          (normalizedStatus === "pendingInit"
            ? "Subagent is initializing."
            : normalizedStatus === "interrupted"
              ? "Subagent was interrupted."
              : "Subagent is running."),
      });
      return;
    }
    if (normalizedStatus === "completed") {
      this.terminalRunIds.add(runId);
      const summary = normalizeOptionalString(message) ?? "Subagent completed.";
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        lastEventAt: eventAt,
        progressSummary: summary,
      });
      return;
    }
    if (normalizedStatus === "blocked") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        status: "succeeded",
        endedAt: eventAt,
        lastEventAt: eventAt,
        progressSummary: normalizeOptionalString(message) ?? "Subagent blocked.",
        terminalSummary: normalizeOptionalString(message) ?? "Subagent blocked.",
        terminalOutcome: "blocked",
      });
      return;
    }
    this.terminalRunIds.add(runId);
    this.runtime.finalizeTaskRunByRunId({
      runId,
      status: normalizedStatus === "shutdown" ? "cancelled" : "failed",
      endedAt: eventAt,
      lastEventAt: eventAt,
      error: normalizeOptionalString(message) ?? `Subagent status: ${normalizedStatus}`,
      progressSummary: normalizeOptionalString(message) ?? `Subagent ${normalizedStatus}.`,
      terminalSummary: normalizeOptionalString(message) ?? "Subagent did not complete.",
    });
  }
}

/** Reads a subagent thread-spawn source only when it belongs to the expected parent thread. */
function readSubagentThreadSpawnSource(
  source: CodexSessionSource | null | undefined,
  parentThreadId: string,
): CodexSubAgentThreadSpawnSource | undefined {
  if (!source || typeof source !== "object" || !("subAgent" in source)) {
    return undefined;
  }
  const subAgent = source.subAgent;
  if (!subAgent || typeof subAgent !== "object" || !("thread_spawn" in subAgent)) {
    return undefined;
  }
  const spawn = subAgent.thread_spawn;
  if (!spawn || typeof spawn !== "object") {
    return undefined;
  }
  return spawn.parent_thread_id === parentThreadId ? spawn : undefined;
}

function readThreadStartedNotification(
  params: JsonObject,
): CodexThreadStartedNotification | undefined {
  const thread = params.thread;
  if (!isJsonObject(thread) || typeof thread.id !== "string") {
    return undefined;
  }
  return { thread: thread as CodexThread };
}

function readThreadStatusChangedNotification(
  params: JsonObject,
): CodexThreadStatusChangedNotification | undefined {
  if (typeof params.threadId !== "string") {
    return undefined;
  }
  const status = params.status;
  if (!isJsonObject(status) || !isCodexThreadStatusType(status.type)) {
    return undefined;
  }
  return {
    threadId: params.threadId,
    status: status as CodexThreadStatus,
  };
}

function isCodexThreadStatusType(value: unknown): value is CodexThreadStatus["type"] {
  return value === "notLoaded" || value === "idle" || value === "systemError" || value === "active";
}

function readAgentsStates(
  value: JsonValue | undefined,
): Map<string, { status?: string; message?: string | null }> {
  const states = new Map<string, { status?: string; message?: string | null }>();
  if (!isJsonObject(value)) {
    return states;
  }
  for (const [threadId, rawState] of Object.entries(value)) {
    if (!isJsonObject(rawState)) {
      continue;
    }
    const status = readString(rawState, "status");
    const message = readNullableString(rawState, "message");
    states.set(threadId, { status, message });
  }
  return states;
}

function readNullableString(value: JsonObject, key: string): string | null | undefined {
  const entry = value[key];
  return typeof entry === "string" || entry === null ? entry : undefined;
}

function normalizeToolName(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function normalizeSubagentActivityKind(
  value: string | undefined,
): "started" | "interacted" | "interrupted" | undefined {
  const key = value?.replace(/[^a-z]/giu, "").toLowerCase();
  return key === "started" || key === "interacted" || key === "interrupted" ? key : undefined;
}

function normalizeCollabToolCallStatus(value: string | undefined): string | undefined {
  const key = value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (key === "completed" || key === "succeeded" || key === "success") {
    return "completed";
  }
  if (key === "failed" || key === "error" || key === "errored") {
    return "failed";
  }
  if (key === "blocked" || key === "declined") {
    return "blocked";
  }
  if (key === "inprogress" || key === "running") {
    return "running";
  }
  return value?.trim();
}

function isBlockedOrFailedCollabToolCallStatus(value: string | undefined): boolean {
  return value === "failed" || value === "blocked";
}

function isNonTerminalAgentStateStatus(value: string | undefined): boolean {
  return value === "pendingInit" || value === "running" || value === "interrupted";
}

function isTerminalAgentStateStatus(value: string | undefined): boolean {
  return value !== undefined && !isNonTerminalAgentStateStatus(value);
}

function normalizeAgentStateStatus(value: string | undefined): string | undefined {
  const key = value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (!key) {
    return undefined;
  }
  if (key === "pendinginit") {
    return "pendingInit";
  }
  if (key === "inprogress" || key === "running") {
    return "running";
  }
  if (key === "completed" || key === "succeeded" || key === "success") {
    return "completed";
  }
  if (key === "interrupted" || key === "cancelled" || key === "canceled" || key === "shutdown") {
    return key === "shutdown" ? "shutdown" : "interrupted";
  }
  if (key === "failed" || key === "error" || key === "systemerror") {
    return "failed";
  }
  if (key === "blocked" || key === "declined") {
    return "blocked";
  }
  return value?.trim();
}

function secondsToMillis(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value * 1000;
}
