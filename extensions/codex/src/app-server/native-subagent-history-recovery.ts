import { isDeepStrictEqual } from "node:util";
import {
  matchesAgentHarnessTaskAssignment,
  type AgentHarnessTaskRecord,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import {
  asFiniteNumber,
  normalizeOptionalString,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertHistoryOwnerMatchesRegistration,
  type CodexNativeSubagentHistoryOwner,
  matchesCodexNativeSubagentHistoryOwner,
  readCodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import type {
  ChildState,
  ParentState,
  TaskRecoveryCandidate,
  NativeSubagentMonitorClient,
  NativeTurnEnd,
  NativeTurnObservation,
  NativeTurnState,
  RecoveredCompletion,
  ThreadRecovery,
} from "./native-subagent-monitor-types.js";
import type { CodexNativeSubagentCompletion } from "./native-subagent-notification.js";
import {
  normalizeIdentifier,
  readNativeTaskAssignment,
  readThreadParentThreadId,
  readThreadSpawnSource,
  type NativeSubagentAssignment,
} from "./native-subagent-task-ids.js";
import type { JsonObject } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

type NativeSubagentCurrentAssignmentState = {
  runId: string | undefined;
  nativeTurnState: NativeTurnState | undefined;
};

type NativeSubagentHistoryQueries = {
  getPendingTurnIds: (childThreadId: string) => readonly string[];
  getCurrentAssignmentState: (
    childThreadId: string,
  ) => NativeSubagentCurrentAssignmentState | undefined;
};

const THREAD_READ_TIMEOUT_MS = 30_000;
const RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS = 60_000;

export class CodexNativeSubagentHistoryRecovery {
  private readonly recoveredParentSources = new Map<ParentState, Set<ParentState>>();

  constructor(
    private readonly client: Pick<NativeSubagentMonitorClient, "request">,
    private readonly queries: NativeSubagentHistoryQueries,
  ) {}

  retainRecoveryParents(recovered: Iterable<ParentState | undefined>, source: ParentState): void {
    for (const parent of recovered) {
      if (!parent || parent === source) {
        continue;
      }
      const sources = this.recoveredParentSources.get(parent) ?? new Set<ParentState>();
      sources.add(source);
      this.recoveredParentSources.set(parent, sources);
    }
  }

  forgetRecoveredParent(state: ParentState): void {
    const ancestors = this.recoveredParentSources.get(state);
    if (ancestors) {
      for (const sources of this.recoveredParentSources.values()) {
        if (sources.has(state)) {
          for (const ancestor of ancestors) {
            sources.add(ancestor);
          }
        }
      }
    }
    this.recoveredParentSources.delete(state);
  }

  parentsForRetirement(parentThreadId: string, parents: ReadonlyMap<string, ParentState>) {
    const current = parents.get(parentThreadId);
    const retiring = new Set<ParentState>(current ? [current] : []);
    // The foreground registration can be pruned while recovered old-parent work
    // continues. Keep its exact owner identity until that recovered state is gone.
    for (const sources of this.recoveredParentSources.values()) {
      for (const source of sources) {
        if (
          source.parentThreadId === parentThreadId &&
          (!current ||
            source === current ||
            (source.historyOwner && current.historyOwner && this.acceptsParent(source, current)))
        ) {
          retiring.add(source);
        }
      }
    }
    for (const source of retiring) {
      for (const [recovered, sources] of this.recoveredParentSources) {
        if (sources.has(source)) {
          retiring.add(recovered);
        }
      }
    }
    return [...retiring].filter((state) => parents.get(state.parentThreadId) === state);
  }

  selectTaskRecords(state: ParentState, records = state.taskRuntime?.listTaskRecords() ?? []) {
    return records
      .filter((task) => this.acceptsTask(task, state))
      .toSorted((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  }

  acceptsParent(
    stored: Pick<ParentState, "requesterSessionKey" | "historyOwner">,
    current: ParentState,
  ): boolean {
    return (
      stored.requesterSessionKey === current.requesterSessionKey &&
      (!stored.historyOwner ||
        (current.historyOwner !== undefined &&
          matchesCodexNativeSubagentHistoryOwner(stored.historyOwner, current.historyOwner)))
    );
  }

  acceptsTask(task: AgentHarnessTaskRecord, state: ParentState): boolean {
    if (task.requesterSessionKey !== state.requesterSessionKey) {
      return false;
    }
    return this.acceptsParent(
      {
        requesterSessionKey: task.requesterSessionKey,
        historyOwner: readCodexNativeSubagentHistoryOwner(task.detail),
      },
      state,
    );
  }

  canRestoreTask(task: AgentHarnessTaskRecord, state: ParentState): boolean {
    const history = readCodexNativeSubagentHistoryOwner(task.detail);
    try {
      assertHistoryOwnerMatchesRegistration(
        history,
        state.historyOwner,
        history?.parentThreadId ?? state.parentThreadId,
        true,
      );
      return this.acceptsTask(task, state);
    } catch {
      return false;
    }
  }

  readReceiverTask(state: ParentState, childThreadId: string) {
    const records = state.taskRuntime?.listTaskRecords() ?? [];
    const task = records
      .toSorted((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt))
      .find((record) => readNativeTaskAssignment(record)?.childThreadId === childThreadId);
    const assignment = task && readNativeTaskAssignment(task);
    const history = task && readCodexNativeSubagentHistoryOwner(task.detail);
    if (!task) {
      return undefined;
    }
    if (
      !assignment ||
      !history ||
      (history.parentThreadId !== state.parentThreadId &&
        !["succeeded", "failed", "cancelled"].includes(task.status)) ||
      !this.canRestoreTask(task, state)
    ) {
      return { restorable: false as const };
    }
    return {
      restorable: true as const,
      assignment,
      nativeParentThreadId: history.parentThreadId,
      records: this.selectTaskRecords(state, records),
    };
  }

  readChildAssignments(
    state: ParentState,
    assignment: NativeSubagentAssignment,
    tasks: readonly AgentHarnessTaskRecord[],
  ) {
    let current: NativeSubagentAssignment & { initialTurnId?: string } = assignment;
    let latestAt = -Infinity;
    let terminal = false;
    let nativeParentThreadId = state.parentThreadId;
    const storedTurnIds = new Set<string>();
    const completedRunIds: string[] = [];
    for (const task of tasks) {
      const candidate = readNativeTaskAssignment(task);
      if (!this.acceptsTask(task, state) || candidate?.childThreadId !== assignment.childThreadId) {
        continue;
      }
      const history = readCodexNativeSubagentHistoryOwner(task.detail);
      if (history && !this.canRestoreTask(task, state)) {
        continue;
      }
      const taskTerminal =
        task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
      if (taskTerminal) {
        completedRunIds.push(candidate.runId);
      }
      for (const turnId of [candidate.nativeTurnId, candidate.initialTurnId]) {
        if (turnId) {
          storedTurnIds.add(turnId);
        }
      }
      const startedAt = task.startedAt ?? task.createdAt;
      if (startedAt > latestAt) {
        current = {
          ...candidate,
          nativeTurnId:
            candidate.nativeTurnId ??
            (candidate.runId === assignment.runId ? assignment.nativeTurnId : undefined),
        };
        terminal = taskTerminal;
        nativeParentThreadId = history?.parentThreadId ?? state.parentThreadId;
        latestAt = startedAt;
      }
    }
    return {
      current,
      found: latestAt !== -Infinity,
      terminal,
      nativeParentThreadId,
      storedTurnIds,
      completedRunIds,
    };
  }

  shouldReconcileTask(task: AgentHarnessTaskRecord, now: number): boolean {
    if (
      task.status === "queued" ||
      task.status === "running" ||
      task.deliveryStatus === "pending"
    ) {
      return true;
    }
    if (task.deliveryStatus !== "not_applicable" || task.endedAt === undefined) {
      return false;
    }
    return task.endedAt >= now - RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS;
  }

  prepareTaskRead(candidate: TaskRecoveryCandidate, child: ChildState | undefined, now: number) {
    const tasks = candidate.taskRuntime
      .listTaskRecords()
      .filter((record) => record.runId === candidate.runId);
    const task = tasks[0];
    if (
      tasks.length !== 1 ||
      !task ||
      !matchesAgentHarnessTaskAssignment(task, candidate.expectedTask) ||
      !this.acceptsTask(task, candidate.parentState) ||
      !this.shouldReconcileTask(task, now) ||
      (child?.expectedTask && !matchesAgentHarnessTaskAssignment(task, child.expectedTask))
    ) {
      return undefined;
    }
    const assignment = child ?? readNativeTaskAssignment(task);
    if (!assignment) {
      return undefined;
    }
    return {
      task,
      historyOwner: readCodexNativeSubagentHistoryOwner(task.detail),
      assignment,
      terminal:
        task.status === "succeeded" || task.status === "failed" || task.status === "cancelled",
    };
  }

  isCurrentTask(
    candidate: TaskRecoveryCandidate,
    task: AgentHarnessTaskRecord,
    history: CodexNativeSubagentHistoryOwner | undefined,
    parentThreadId: string,
    now: number,
  ): boolean {
    const currentTasks = candidate.taskRuntime
      .listTaskRecords()
      .filter((record) => record.runId === candidate.runId);
    const current = currentTasks[0];
    if (
      currentTasks.length !== 1 ||
      !current ||
      !matchesAgentHarnessTaskAssignment(current, candidate.expectedTask) ||
      !matchesAgentHarnessTaskAssignment(task, candidate.expectedTask)
    ) {
      return false;
    }
    try {
      // History access can follow compaction; automatic completion cannot acquire
      // a different physical requester's authority from that readable lineage.
      assertHistoryOwnerMatchesRegistration(
        readCodexNativeSubagentHistoryOwner(current.detail),
        candidate.parentState.historyOwner,
        parentThreadId,
        true,
      );
    } catch {
      return false;
    }
    return (
      current &&
      current.taskId === task.taskId &&
      this.acceptsTask(current, candidate.parentState) &&
      this.shouldReconcileTask(current, now) &&
      isDeepStrictEqual(readCodexNativeSubagentHistoryOwner(current.detail), history) &&
      // Unstamped rows can recover only through the current native parent.
      parentThreadId === (history?.parentThreadId ?? candidate.parentState.parentThreadId)
    );
  }

  private requestThreadRead(childThreadId: string, includeTurns: boolean) {
    return this.client.request(
      "thread/read",
      {
        threadId: childThreadId,
        includeTurns,
      },
      {
        timeoutMs: THREAD_READ_TIMEOUT_MS,
      },
    );
  }

  private requestLatestThreadTurn(childThreadId: string) {
    return this.client.request(
      "thread/turns/list",
      {
        threadId: childThreadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      },
      { timeoutMs: THREAD_READ_TIMEOUT_MS },
    );
  }

  readTask(
    assignment: NativeSubagentAssignment,
    task: AgentHarnessTaskRecord,
    candidate: TaskRecoveryCandidate,
  ): Promise<ThreadRecovery> {
    const recordedStatus =
      task.status === "succeeded" || task.status === "failed" || task.status === "cancelled"
        ? task.status
        : undefined;
    return this.read(assignment, {
      resumeInterrupted: task.status === "queued" || task.status === "running",
      getTaskRecords: () => this.selectTaskRecords(candidate.parentState),
      observedTurns: candidate.observedTurns,
      ...(recordedStatus && task.terminalSummary
        ? {
            recordedCompletion: {
              childThreadId: candidate.childThreadId,
              status: recordedStatus,
              statusLabel: "recorded_task_result",
              result: task.terminalSummary,
              completedAt: task.endedAt,
            },
          }
        : {}),
    });
  }

  async read(
    assignment: NativeSubagentAssignment,
    options: {
      resumeInterrupted: boolean;
      getTaskRecords: () => readonly AgentHarnessTaskRecord[];
      recordedCompletion?: RecoveredCompletion;
      observedTurns?: readonly NativeTurnObservation[];
    },
  ): Promise<ThreadRecovery> {
    const { childThreadId } = assignment;
    const { recordedCompletion } = options;
    // Fresh threads can expose lineage before includeTurns history is materialized.
    // Register that lineage now so the normal child backoff owns later full reads.
    const response = await this.requestThreadRead(childThreadId, true).catch(() =>
      this.requestThreadRead(childThreadId, false),
    );
    const thread = isJsonObject(response.thread) ? response.thread : undefined;
    if (!thread || readString(thread, "id")?.trim() !== childThreadId) {
      return { resumable: false, threadState: "unavailable", observedPendingTurns: [] };
    }
    const firstObserved = options.observedTurns?.[0];
    // Forked history can begin with copied parent turns. Only a native child
    // end observed before successor starts can anchor an unlocated predecessor.
    const observedPredecessor =
      options.resumeInterrupted &&
      firstObserved?.state &&
      firstObserved.state !== "active" &&
      !firstObserved.startObserved
        ? firstObserved.turnId
        : undefined;
    const turnId = assignment.nativeTurnId ?? observedPredecessor;
    const pendingTurnIds = new Set([
      ...this.queries.getPendingTurnIds(childThreadId),
      ...(options.observedTurns?.map((turn) => turn.turnId) ?? []),
    ]);
    const unresolvedAssignment = options.resumeInterrupted && !turnId && pendingTurnIds.size > 0;
    const observedPendingTurns: ThreadRecovery["observedPendingTurns"] = [];
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      const pendingTurnId = readString(turn, "id");
      if (pendingTurnId && pendingTurnIds.has(pendingTurnId)) {
        observedPendingTurns.push({ turnId: pendingTurnId, state: readNativeTurnState(turn) });
      }
    }
    const threadStatus = isJsonObject(thread.status)
      ? normalizeIdentifier(readString(thread.status, "type"))
      : undefined;
    let completion: RecoveredCompletion | undefined;
    let fallbackCompletion: RecoveredCompletion | undefined;
    let nativeTurnId: string | undefined;
    let nativeTurnState: NativeTurnState | undefined;
    let resumable = false;
    let threadState: ThreadRecovery["threadState"] =
      threadStatus === "active"
        ? "active"
        : threadStatus === "systemerror"
          ? "system_error"
          : threadStatus
            ? "other"
            : "unavailable";
    if (unresolvedAssignment) {
      threadState = "unavailable";
    } else if (turnId) {
      const turns = Array.isArray(thread.turns) ? thread.turns.filter(isJsonObject) : [];
      let index = turns.findIndex((turn) => readString(turn, "id") === turnId);
      // A missed resume notification can leave an unfinished assignment on an
      // interrupted turn. Stop at its first terminal turn, before any later assignment.
      while (
        options.resumeInterrupted &&
        index >= 0 &&
        index + 1 < turns.length &&
        normalizeIdentifier(readString(turns[index], "status")) === "interrupted"
      ) {
        index += 1;
      }
      const turn = turns[index];
      const turnStatus = normalizeIdentifier(readString(turn, "status"));
      nativeTurnId = readString(turn, "id");
      nativeTurnState = readNativeTurnState(turn);
      completion = isJsonObject(turn) ? readTurnCompletion(turn, childThreadId) : undefined;
      resumable = turnStatus === "interrupted";
      threadState = turnStatus === "inprogress" ? "active" : turnStatus ? "other" : "unavailable";
    } else if (threadStatus === "active") {
      const turn = Array.isArray(thread.turns) ? thread.turns.at(-1) : undefined;
      if (normalizeIdentifier(readString(turn, "status")) === "inprogress") {
        nativeTurnId = readString(turn, "id");
        nativeTurnState = "active";
      }
    } else if (threadStatus !== "systemerror") {
      const turnRecovery = readThreadTurnRecovery(thread, childThreadId);
      nativeTurnId = turnRecovery.nativeTurnId;
      nativeTurnState = turnRecovery.nativeTurnState;
      completion = turnRecovery.completion;
      resumable = turnRecovery.resumable;
    }
    if (
      !unresolvedAssignment &&
      threadStatus === "systemerror" &&
      (!turnId || (threadState === "unavailable" && !completion))
    ) {
      // The pinned protocol's paged history distinguishes the failed current
      // turn from earlier persisted results.
      const turnsResponse = await this.requestLatestThreadTurn(childThreadId).catch(
        () => undefined,
      );
      const data =
        isJsonObject(turnsResponse) && Array.isArray(turnsResponse.data) ? turnsResponse.data : [];
      const latestTurn = isJsonObject(data[0]) ? data[0] : undefined;
      const latestTurnId = readString(latestTurn, "id");
      if (latestTurnId && pendingTurnIds.has(latestTurnId)) {
        observedPendingTurns.push({ turnId: latestTurnId, state: readNativeTurnState(latestTurn) });
      }
      const latestTurnStatus = normalizeIdentifier(readString(latestTurn, "status"));
      const matchesAssignment = !turnId || readString(latestTurn, "id") === turnId;
      if (latestTurn && matchesAssignment) {
        if (turnId) {
          const turnRecovery = readThreadTurnRecovery({ turns: [latestTurn] }, childThreadId);
          nativeTurnId = turnRecovery.nativeTurnId;
          nativeTurnState = turnRecovery.nativeTurnState;
          completion = turnRecovery.completion;
          resumable = turnRecovery.resumable;
        } else if (latestTurnStatus === "failed") {
          completion = readTurnCompletion(latestTurn, childThreadId);
        }
      }
      const current = !latestTurn
        ? this.queries.getCurrentAssignmentState(childThreadId)
        : undefined;
      const taskRecords = !latestTurn ? options.getTaskRecords() : [];
      const task = taskRecords.find((record) => record.runId === assignment.runId);
      // A delivered successor can outlive its monitor state. Its task row still
      // prevents a thread-wide error from being assigned to an older pending result.
      const hasSuccessor =
        task &&
        taskRecords.some(
          (record) =>
            record.requesterSessionKey === task.requesterSessionKey &&
            (record.startedAt ?? record.createdAt) > (task.startedAt ?? task.createdAt) &&
            readNativeTaskAssignment(record)?.childThreadId === childThreadId,
        );
      const unresolvedCurrentAssignment =
        current?.runId === assignment.runId &&
        current?.nativeTurnState !== "completed" &&
        !hasSuccessor;
      if (latestTurnStatus === "inprogress" && matchesAssignment) {
        nativeTurnId = readString(latestTurn, "id");
        nativeTurnState = "active";
        threadState = "active";
      } else if (
        !completion &&
        !resumable &&
        latestTurnStatus !== "inprogress" &&
        (!turnId || (!latestTurn && unresolvedCurrentAssignment))
      ) {
        // A missing live snapshot must still settle: retry briefly, then report
        // the current assignment's error without failing an older pending result.
        fallbackCompletion = systemErrorFallbackCompletion(childThreadId);
      }
    }
    if (
      recordedCompletion &&
      (!turnId || !completion || completion.status !== recordedCompletion.status)
    ) {
      completion = recordedCompletion;
      if (!turnId) {
        nativeTurnId = undefined;
        nativeTurnState = undefined;
      }
      fallbackCompletion = undefined;
      resumable = false;
      threadState = "other";
    }
    const lineage = {
      parentThreadId: readThreadParentThreadId(thread),
      agentPath: normalizeOptionalString(readString(readThreadSpawnSource(thread), "agent_path")),
    };
    if (!turnId && !recordedCompletion && hasSavedSuccessor(assignment, options.getTaskRecords())) {
      return {
        ...lineage,
        assignmentUnresolved: true,
        observedPendingTurns,
        resumable: false,
        threadState: "unavailable",
      };
    }
    return {
      ...lineage,
      assignmentTurnId: turnId,
      nativeTurnId,
      nativeTurnState,
      observedPendingTurns,
      completion,
      fallbackCompletion,
      resumable,
      threadState,
    };
  }
}

function hasSavedSuccessor(
  assignment: NativeSubagentAssignment,
  records: readonly AgentHarnessTaskRecord[],
): boolean {
  const task = records.find((record) => record.runId === assignment.runId);
  return Boolean(
    task &&
    records.some((record) => {
      const successor = readNativeTaskAssignment(record);
      // Later assignments have turn-qualified run IDs even when their timestamps tie.
      return (
        record.requesterSessionKey === task.requesterSessionKey &&
        record.runId !== assignment.runId &&
        successor?.childThreadId === assignment.childThreadId &&
        Boolean(successor.initialTurnId)
      );
    }),
  );
}

function readThreadTurnRecovery(
  thread: JsonObject,
  childThreadId: string,
): Pick<ThreadRecovery, "completion" | "resumable" | "nativeTurnId" | "nativeTurnState"> {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const turn = turns.findLast(isJsonObject);
  return turn
    ? {
        nativeTurnId: readString(turn, "id"),
        nativeTurnState: readNativeTurnState(turn),
        completion: readTurnCompletion(turn, childThreadId),
        resumable: normalizeIdentifier(readString(turn, "status")) === "interrupted",
      }
    : { resumable: false };
}

export function readNativeTurnEnd(
  turn: Record<string, unknown> | undefined,
): NativeTurnEnd | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  return status === "completed" || status === "failed" || status === "interrupted"
    ? status
    : undefined;
}

function readNativeTurnState(
  turn: Record<string, unknown> | undefined,
): NativeTurnState | undefined {
  return normalizeIdentifier(readString(turn, "status")) === "inprogress"
    ? "active"
    : readNativeTurnEnd(turn);
}

function readTurnErrorMessage(turn: JsonObject): string | undefined {
  const error = isJsonObject(turn.error) ? turn.error : undefined;
  return (
    normalizeOptionalString(readString(error, "message")) ??
    normalizeOptionalString(
      isJsonObject(error?.codexErrorInfo) ? readString(error.codexErrorInfo, "message") : undefined,
    )
  );
}

export function systemErrorFallbackCompletion(childThreadId: string): RecoveredCompletion {
  return {
    childThreadId,
    status: "failed",
    statusLabel: "system_error",
    result: "Subagent runtime reported a system error.",
  };
}

export function readTurnCompletion(
  turn: JsonObject,
  childThreadId: string,
  source: "history" | "notification" = "history",
): RecoveredCompletion | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  if (status === "inprogress" || !status) {
    return undefined;
  }
  const result = readLastAgentMessage(turn);
  const completedAtSeconds = asFiniteNumber(turn.completedAt);
  const timestamp =
    source === "history"
      ? {
          completedAt:
            completedAtSeconds === undefined ? undefined : Math.round(completedAtSeconds * 1_000),
        }
      : {};
  if (status === "completed") {
    return {
      childThreadId,
      status: "succeeded",
      statusLabel: result
        ? source === "history"
          ? "task_complete"
          : "turn_completed"
        : "completed_without_final_message",
      result: result ?? "Subagent completed without a final assistant message.",
      ...timestamp,
    };
  }
  // Codex keeps interrupted subagents resumable. They remain a running task
  // until a later turn reaches an authoritative terminal state.
  if (status === "interrupted") {
    return undefined;
  }
  if (status === "failed") {
    return {
      childThreadId,
      status: "failed",
      statusLabel: source === "history" ? "task_failed" : "turn_failed",
      result:
        readTurnErrorMessage(turn) ??
        (source === "history" ? result : undefined) ??
        "Subagent failed.",
      ...timestamp,
    };
  }
  return undefined;
}

function readLastAgentMessage(turn: JsonObject): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  let legacyResult: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isJsonObject(item)) {
      continue;
    }
    if (normalizeIdentifier(readString(item, "type")) !== "agentmessage") {
      continue;
    }
    const text = readString(item, "text")?.trim();
    if (!text) {
      continue;
    }
    const phase = normalizeIdentifier(readString(item, "phase"));
    if (phase === "finalanswer") {
      return text;
    }
    if (!phase) {
      legacyResult ??= text;
    }
  }
  return legacyResult;
}

export function isNoFinalCompletion(completion: CodexNativeSubagentCompletion): boolean {
  return (
    completion.status === "succeeded" &&
    completion.statusLabel === "completed_without_final_message"
  );
}
