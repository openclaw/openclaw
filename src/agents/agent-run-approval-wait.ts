import { onAgentEventForRun } from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";

export type AgentRunApprovalWait = {
  pending: boolean;
  pausedMs: number;
  onChange?: (pending: boolean) => void;
  dispose: () => void;
};

export function observeAgentRunApprovalWait(params: {
  runId?: string;
  sessionId?: string;
}): AgentRunApprovalWait {
  const approvals = new Set<string>();
  let pausedAtMs = 0;
  let completedPausedMs = 0;
  let unsubscribe = () => {};
  const state: AgentRunApprovalWait = {
    pending: false,
    // Include an open interval so each exec/wait can take its own baseline;
    // time spent parked before that call never becomes execution credit.
    get pausedMs() {
      return completedPausedMs + (state.pending ? Math.max(0, performance.now() - pausedAtMs) : 0);
    },
    dispose: () => {
      unsubscribe();
      state.onChange = undefined;
    },
  };
  if (!params.runId) {
    return state;
  }
  // Lifecycle facts pause scheduling only; the original admitted run retains all authority.
  unsubscribe = onAgentEventForRun(params.runId, (event) => {
    if (
      event.runId !== params.runId ||
      event.stream !== "lifecycle" ||
      (params.sessionId && event.sessionId && event.sessionId !== params.sessionId)
    ) {
      return;
    }
    const approvalId = event.data.approvalId;
    if (typeof approvalId !== "string" || !approvalId) {
      return;
    }
    if (event.data.phase === "waiting-approval") {
      approvals.add(approvalId);
    } else if (event.data.phase === "approval-resolved") {
      approvals.delete(approvalId);
    } else {
      return;
    }
    const pending = approvals.size > 0;
    if (pending === state.pending) {
      return;
    }
    if (pending) {
      pausedAtMs = performance.now();
    } else {
      completedPausedMs += Math.max(0, performance.now() - pausedAtMs);
    }
    state.pending = pending;
    state.onChange?.(pending);
  });
  return state;
}

export type AgentRunHumanWaitSnapshot = { waiting: boolean; resumeRequired: boolean };

export type AgentRunHumanWait = {
  waiting: boolean;
  resumeRequired: boolean;
  onChange?: (snapshot: AgentRunHumanWaitSnapshot) => void;
  /** Clear a resolved wait only when the caller observes real execution resuming. */
  markExecutionResumed: () => void;
  dispose: () => void;
};

/** Observe exact approval and input waits for one active agent run. */
export function observeAgentRunHumanWait(params: {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
}): AgentRunHumanWait {
  const approvals = new Set<string>();
  const executionWaits = new Map<string, string>();
  // Legacy wait events may omit an execution id; keep their custody separate from exact ids.
  const unidentifiedExecutionWaits = new Set<string>();
  let unknownWait = false;
  let unknownWaitExecutionKey: string | undefined;
  let awaitingExecution = false;
  let unsubscribe = () => {};
  const state: AgentRunHumanWait = {
    waiting: false,
    resumeRequired: false,
    markExecutionResumed: () => {
      if (!awaitingExecution && !unknownWait && unidentifiedExecutionWaits.size === 0) {
        return;
      }
      awaitingExecution = false;
      unknownWait = false;
      unknownWaitExecutionKey = undefined;
      unidentifiedExecutionWaits.clear();
      publish();
    },
    dispose: () => {
      unsubscribe();
      state.onChange = undefined;
    },
  };

  const publish = () => {
    const waiting =
      approvals.size > 0 ||
      executionWaits.size > 0 ||
      unidentifiedExecutionWaits.size > 0 ||
      unknownWait;
    const resumeRequired = !waiting && awaitingExecution;
    if (state.waiting === waiting && state.resumeRequired === resumeRequired) {
      return;
    }
    state.waiting = waiting;
    state.resumeRequired = resumeRequired;
    state.onChange?.({ waiting, resumeRequired });
  };

  const context = params.runId ? getAgentRunContext(params.runId) : undefined;
  if (
    context &&
    (!params.sessionKey || context.sessionKey === params.sessionKey) &&
    (!params.sessionId || !context.sessionId || context.sessionId === params.sessionId)
  ) {
    for (const approvalId of context.executionActivity?.pendingApprovalIds ?? []) {
      approvals.add(approvalId);
    }
    const execution = context.executionActivity?.execution;
    if (execution?.state === "waiting") {
      const sourceId = execution.sourceId ?? "execution";
      const executionId =
        typeof execution.id === "string" && execution.id.trim().length > 0
          ? execution.id
          : undefined;
      if (execution.wait === "approval") {
        if (approvals.size === 0) {
          unknownWait = true;
          unknownWaitExecutionKey = executionId ? sourceId + "\0" + executionId : undefined;
        }
      } else if (executionId) {
        executionWaits.set(sourceId + "\0" + executionId, sourceId);
      } else {
        unidentifiedExecutionWaits.add(sourceId);
      }
    }
    if (context.executionActivity?.approvalOverflow) {
      unknownWait = true;
      // Overflow has no exact execution owner; keep it fail-closed.
      unknownWaitExecutionKey = undefined;
    }
    publish();
  }

  if (!params.runId) {
    return state;
  }
  unsubscribe = onAgentEventForRun(params.runId, (event) => {
    if (
      event.runId !== params.runId ||
      (params.sessionKey && event.sessionKey && event.sessionKey !== params.sessionKey) ||
      (params.sessionId && event.sessionId && event.sessionId !== params.sessionId)
    ) {
      return;
    }
    if (event.stream === "lifecycle") {
      const approvalId = event.data.approvalId;
      if (typeof approvalId !== "string" || !approvalId) {
        if (event.data.phase === "end" || event.data.phase === "error") {
          approvals.clear();
          executionWaits.clear();
          unidentifiedExecutionWaits.clear();
          unknownWait = false;
          unknownWaitExecutionKey = undefined;
          awaitingExecution = false;
          publish();
        }
        return;
      }
      if (event.data.phase === "waiting-approval") {
        approvals.add(approvalId);
        awaitingExecution = false;
      } else if (event.data.phase === "approval-resolved") {
        approvals.delete(approvalId);
        if (
          approvals.size === 0 &&
          executionWaits.size === 0 &&
          unidentifiedExecutionWaits.size === 0 &&
          !unknownWait
        ) {
          awaitingExecution = true;
        }
      } else {
        return;
      }
      publish();
      return;
    }
    if (event.stream !== "execution") {
      return;
    }
    const sourceId = typeof event.data.sourceId === "string" ? event.data.sourceId : "execution";
    const executionIdValue =
      typeof event.data.executionId === "string" && event.data.executionId.trim().length > 0
        ? event.data.executionId
        : typeof event.data.id === "string" && event.data.id.trim().length > 0
          ? event.data.id
          : undefined;
    const hasExecutionId = executionIdValue !== undefined;
    const key = sourceId + "\0" + (executionIdValue ?? sourceId);
    if (event.data.state === "waiting") {
      if (hasExecutionId) {
        executionWaits.set(key, sourceId);
      } else {
        unidentifiedExecutionWaits.add(sourceId);
      }
      awaitingExecution = false;
    } else if (event.data.state === "unknown") {
      if (
        hasExecutionId &&
        executionWaits.delete(key) &&
        approvals.size === 0 &&
        executionWaits.size === 0 &&
        unidentifiedExecutionWaits.size === 0
      ) {
        awaitingExecution = true;
      }
      if (hasExecutionId && unknownWait && unknownWaitExecutionKey === key) {
        unknownWait = false;
        unknownWaitExecutionKey = undefined;
        if (
          approvals.size === 0 &&
          executionWaits.size === 0 &&
          unidentifiedExecutionWaits.size === 0
        ) {
          awaitingExecution = true;
        }
      }
    } else if (event.data.state === "running") {
      if (hasExecutionId) {
        executionWaits.delete(key);
      }
      if (hasExecutionId && unknownWait && unknownWaitExecutionKey === key) {
        unknownWait = false;
        unknownWaitExecutionKey = undefined;
      }
      if (
        approvals.size === 0 &&
        executionWaits.size === 0 &&
        unidentifiedExecutionWaits.size === 0
      ) {
        awaitingExecution = false;
      }
    }
    // Unidentified wait owners remain fail-closed until confirmed resume or terminal cleanup.
    publish();
  });
  return state;
}
