import * as agentHarnessTaskRuntime from "openclaw/plugin-sdk/agent-harness-task-runtime";
import type {
  AgentHarnessCompletionCustody,
  AgentHarnessTaskRecord,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { readNativeTurnEnd } from "./native-subagent-history-recovery.js";
import type {
  ChildState,
  KnownChild,
  ParentOwner,
  ParentState,
  NativeSubagentMonitorClient,
  PreparedNativeReceiver,
} from "./native-subagent-monitor-types.js";
import {
  logRecoveryFailure,
  type CodexNativeSubagentRecoveryCoordinator,
} from "./native-subagent-recovery-coordinator.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import {
  codexNativeSubagentRunId,
  readNativeTaskAssignment,
  readThreadParentThreadId,
  type NativeSubagentAssignment,
} from "./native-subagent-task-ids.js";
import { isJsonObject, type JsonObject, type CodexServerNotification } from "./protocol.js";

export async function readCodexNativeSubmissionTurn(
  receipt: CodexNativeSubagentSubmission,
  dependencies: {
    client: NativeSubagentMonitorClient;
    recovery: Pick<
      CodexNativeSubagentRecoveryCoordinator,
      "retainThreadStatusRevision" | "reconcileRegisteredChild"
    >;
    prepareReceiver: () => Promise<PreparedNativeReceiver | undefined>;
    isCurrent: () => boolean;
    parentThreadId: () => string;
    currentChild: () => ChildState | undefined;
  },
): Promise<JsonObject | undefined> {
  const receiver = await dependencies.prepareReceiver();
  if (!receiver?.isCurrent() || !dependencies.isCurrent()) {
    return undefined;
  }
  const revision = dependencies.recovery.retainThreadStatusRevision(receipt.childThreadId);
  try {
    const response = await dependencies.client.request(
      "thread/read",
      { threadId: receipt.childThreadId, includeTurns: true },
      { timeoutMs: 30_000 },
    );
    if (!revision.isCurrent() || !dependencies.isCurrent()) {
      return undefined;
    }
    const thread = isJsonObject(response.thread) ? response.thread : undefined;
    if (
      readString(thread, "id") !== receipt.childThreadId ||
      readThreadParentThreadId(thread) !== dependencies.parentThreadId()
    ) {
      return undefined;
    }
    const turns: JsonObject[] = [];
    for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
      if (isJsonObject(turn)) {
        turns.push(turn);
      }
    }
    const predecessorIndex = turns.findIndex(
      (turn) => readString(turn, "id") === receipt.predecessorNativeTurnId,
    );
    const turnIndex = turns.findIndex((turn) => readString(turn, "id") === receipt.submissionId);
    if (
      predecessorIndex < 0 ||
      turnIndex <= predecessorIndex ||
      !["completed", "failed"].includes(readString(turns[predecessorIndex], "status") ?? "")
    ) {
      return undefined;
    }
    const previous = dependencies.currentChild();
    if (previous && !previous.terminal && previous.nativeTurnId !== receipt.submissionId) {
      await dependencies.recovery.reconcileRegisteredChild(previous);
    }
    return dependencies.isCurrent() ? turns[turnIndex] : undefined;
  } finally {
    revision.release();
  }
}

export type NativeSubmissionAdmissionDependencies = {
  knownChildren: ReadonlyMap<string, KnownChild>;
  currentChild: (threadId: string) => ChildState | undefined;
  restoreKnownChild: (
    state: ParentState,
    assignment: NativeSubagentAssignment,
    records: readonly AgentHarnessTaskRecord[],
  ) => void;
  registerChild: (
    state: ParentState,
    assignment: NativeSubagentAssignment,
    options: {
      admitAssignment: true;
      completionCustody?: AgentHarnessCompletionCustody;
      taskRecords?: readonly AgentHarnessTaskRecord[];
    },
  ) => ChildState | undefined;
  admitFollowup: (known: KnownChild, threadId: string) => ChildState | undefined;
  resumeChild: (child: ChildState) => void;
  completeChild: (notification: CodexServerNotification, child: ChildState) => Promise<void>;
};

export async function admitCodexNativeSubmissionTurn(
  params: {
    state: ParentState;
    receipt: CodexNativeSubagentSubmission;
    turn: JsonObject;
    owner: ParentOwner | undefined;
    historyValidated: boolean;
    completionCustody: AgentHarnessCompletionCustody | undefined;
    isCurrent: () => boolean;
    nativeParentThreadId: () => string;
  },
  dependencies: NativeSubmissionAdmissionDependencies,
): Promise<boolean> {
  const {
    state,
    receipt,
    turn,
    owner,
    historyValidated,
    completionCustody,
    isCurrent,
    nativeParentThreadId,
  } = params;
  if (readString(turn, "id") !== receipt.submissionId || !isCurrent()) {
    return false;
  }
  const runId = codexNativeSubagentRunId(receipt.childThreadId, receipt.submissionId);
  let readTaskRecords = state.taskRuntime
    ? await state.taskRuntime.prepareTaskRecordsRead!()
    : () => [];
  if (!isCurrent()) {
    return false;
  }
  const records = readTaskRecords();
  const existing = records.find((task) => task.runId === runId);
  if (existing) {
    const assignment = readNativeTaskAssignment(existing);
    const history = readCodexNativeSubagentHistoryOwner(existing.detail);
    if (
      assignment?.nativeTurnId !== receipt.submissionId ||
      (history && history.parentThreadId !== nativeParentThreadId())
    ) {
      return false;
    }
    if (
      (existing.status === "succeeded" ||
        existing.status === "failed" ||
        existing.status === "cancelled") &&
      existing.deliveryStatus === "delivered"
    ) {
      return true;
    }
  }
  let known = dependencies.knownChildren.get(receipt.childThreadId);
  if (!known) {
    if (!historyValidated) {
      return false;
    }
    dependencies.restoreKnownChild(
      state,
      {
        runId: receipt.predecessorRunId,
        childThreadId: receipt.childThreadId,
        nativeTurnId: receipt.predecessorNativeTurnId,
      },
      records,
    );
    known = dependencies.knownChildren.get(receipt.childThreadId);
    if (
      known &&
      known.assignment.runId === receipt.predecessorRunId &&
      !records.some((task) => task.runId === receipt.predecessorRunId)
    ) {
      known.assignment.terminal = true;
    }
  }
  if (known?.parent !== state) {
    return false;
  }
  if (
    known.assignment.runId !== receipt.predecessorRunId &&
    known.assignment.runId !== runId &&
    !known.pendingTurns.some((pending) => pending.turnId === receipt.submissionId)
  ) {
    return false;
  }
  if (
    known.assignment.runId === receipt.predecessorRunId &&
    known.assignment.nativeTurnId !== receipt.predecessorNativeTurnId
  ) {
    return false;
  }
  const status = readString(turn, "status");
  const nativeState = status === "inProgress" ? "active" : readNativeTurnEnd(turn);
  if (!nativeState) {
    return false;
  }
  if (known.assignment.runId === runId) {
    if (!existing) {
      await state.mirror?.startFollowupTurn(
        receipt.childThreadId,
        receipt.submissionId,
        nativeParentThreadId(),
      );
      if (!isCurrent() || dependencies.knownChildren.get(receipt.childThreadId) !== known) {
        return false;
      }
    }
    const child =
      dependencies.currentChild(receipt.childThreadId) ??
      dependencies.registerChild(
        state,
        { runId, childThreadId: receipt.childThreadId, nativeTurnId: receipt.submissionId },
        { admitAssignment: true, completionCustody, taskRecords: records },
      );
    if (!child) {
      return false;
    }
    child.nativeTurnState = nativeState;
    child.completionCustody ??= completionCustody?.retain();
  } else {
    let pending = known.pendingTurns.find((candidate) => candidate.turnId === receipt.submissionId);
    if (!pending) {
      pending = { turnId: receipt.submissionId, state: nativeState };
      known.pendingTurns.push(pending);
      known.observedTurns.set(receipt.submissionId, {});
    }
    pending.state = nativeState;
    pending.admittedSubmission = receipt;
    pending.completionCustody ??= completionCustody?.retain();
    if (owner && pending.admittedOwner !== owner && [...state.owners.values()].includes(owner)) {
      pending.admittedOwner = owner;
      owner.onDirectChildAccepted?.();
    }
    dependencies.admitFollowup(known, receipt.childThreadId);
  }
  const child = dependencies.currentChild(receipt.childThreadId);
  if (child?.runId !== runId) {
    return false;
  }
  await state.mirror?.waitForTaskCreation(runId);
  if (!isCurrent() || dependencies.currentChild(receipt.childThreadId) !== child) {
    return false;
  }
  readTaskRecords = state.taskRuntime
    ? await state.taskRuntime.prepareTaskRecordsRead!()
    : () => [];
  if (
    !isCurrent() ||
    dependencies.currentChild(receipt.childThreadId) !== child ||
    !child.expectedTask ||
    !readTaskRecords().some((task) =>
      agentHarnessTaskRuntime.matchesAgentHarnessTaskAssignment(task, child.expectedTask!),
    )
  ) {
    return false;
  }
  if (nativeState === "active") {
    dependencies.resumeChild(child);
  } else if (Array.isArray(turn.items)) {
    void dependencies
      .completeChild(
        { method: "turn/completed", params: { threadId: receipt.childThreadId, turn } },
        child,
      )
      .catch((error: unknown) => logRecoveryFailure(receipt.childThreadId, error));
  }
  return true;
}
