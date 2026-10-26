import { formatErrorMessage } from "../../../infra/errors.js";
import {
  beginDiagnosticRetryWait,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  type DiagnosticEmbeddedRunOwner,
} from "../../../logging/diagnostic-run-activity.js";
import type { ReplyOperation } from "../../../sessions/session-controller.contracts.js";
import { getCurrentSessionControllerOwner } from "../../../sessions/session-controller.lifecycle.js";
import { assertSessionControllerOperation } from "../../../sessions/session-controller.state.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "../../run-termination.js";
import { log } from "../logger.js";
import type { EmbeddedAgentQueueHandle } from "../run-state.js";
import { detachActiveEmbeddedRun, attachActiveEmbeddedRun } from "../runs.js";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-trajectory-flush.js";

type DeferredTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
  describeFlushState: () => string | undefined;
};

export type DeferredEmbeddedRunLifecycleOwner = {
  beginRetryWait: (
    deadlineAtMs: number,
    signal: AbortSignal,
    wait?: { rateLimitStopMessage?: string },
  ) => ((completed?: boolean) => void) | undefined;
  complete: () => Promise<void>;
  discard: () => void | Promise<void>;
};

export type EmbeddedAttemptDeferredLifecycleOwner = DeferredEmbeddedRunLifecycleOwner & {
  recordSessionEnd: (data: Record<string, unknown>) => void;
};

export function createEmbeddedAttemptDeferredLifecycleOwner(params: {
  runId: string;
  sessionId: string;
  diagnosticOwner: DiagnosticEmbeddedRunOwner;
  isCurrent: () => boolean;
  onRetryWaitCompleted: () => void;
  trajectoryRecorder: DeferredTrajectoryRecorder | null;
  clearActiveRun: () => void;
}): EmbeddedAttemptDeferredLifecycleOwner {
  let pending: typeof params | undefined = params;
  let sessionEndData: Record<string, unknown> | undefined;
  let closeRetryWait: (() => void) | undefined;
  const releaseRetryWait = () => {
    closeRetryWait?.();
    closeRetryWait = undefined;
  };
  const releaseActiveRun = (owner: typeof params) => {
    try {
      owner.clearActiveRun();
    } catch (error) {
      log.error(
        `CRITICAL: deferred active run cleanup failed, possible resource leak: ` +
          `runId=${owner.runId} ${formatErrorMessage(error)}`,
      );
    }
  };
  const flushTrajectory = (owner: typeof params) =>
    owner.trajectoryRecorder
      ? flushEmbeddedAttemptTrajectoryRecorder({
          runId: owner.runId,
          sessionId: owner.sessionId,
          trajectoryRecorder: owner.trajectoryRecorder,
          log,
        })
      : Promise.resolve();
  return {
    beginRetryWait: (deadlineAtMs, signal, wait) => {
      if (!pending) {
        return undefined;
      }
      // Preserve diagnostic progress before a potentially long retry backoff.
      void flushTrajectory(pending);
      releaseRetryWait();
      const close = beginDiagnosticRetryWait({
        owner: pending.diagnosticOwner,
        deadlineAtMs,
        rateLimitStopMessage: wait?.rateLimitStopMessage,
        signal,
        assertCurrent: () => {
          if (!pending?.isCurrent()) {
            throw createAgentRunSupersededAbortError();
          }
        },
      });
      closeRetryWait = close;
      return (completed) => {
        if (close(completed)) {
          pending?.onRetryWaitCompleted();
        }
        if (closeRetryWait === close) {
          closeRetryWait = undefined;
        }
      };
    },
    recordSessionEnd: (data) => {
      if (pending) {
        sessionEndData = data;
      }
    },
    discard: () => {
      if (pending) {
        const owner = pending;
        pending = undefined;
        sessionEndData = undefined;
        releaseRetryWait();
        releaseActiveRun(owner);
        return flushTrajectory(owner);
      }
      return undefined;
    },
    complete: async () => {
      if (!pending) {
        return;
      }
      const owner = pending;
      pending = undefined;
      releaseRetryWait();
      try {
        if (owner.trajectoryRecorder && sessionEndData) {
          owner.trajectoryRecorder.recordEvent("session.ended", sessionEndData);
        }
        // Successful attempts keep their diagnostic prefix for this terminal batch.
        await flushTrajectory(owner);
      } finally {
        sessionEndData = undefined;
        releaseActiveRun(owner);
      }
    },
  };
}

export type DeferredEmbeddedRunLifecycleManager = {
  signal: AbortSignal;
  abort: (reason?: "user_abort" | "restart" | "superseded") => void;
  adopt: (owner: DeferredEmbeddedRunLifecycleOwner) => void;
  beginRetryWait: (
    deadlineAtMs: number,
    signal?: AbortSignal,
    wait?: { rateLimitStopMessage?: string },
  ) => ((completed?: boolean) => void) | undefined;
  handoffToCli: () => DiagnosticEmbeddedRunOwner;
  complete: () => Promise<void>;
};

export function createDeferredEmbeddedRunLifecycleManager(params: {
  replyOperation?: ReplyOperation;
  runId: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  abortSignal?: AbortSignal;
}): DeferredEmbeddedRunLifecycleManager {
  // Recovery projections time the whole logical turn, not the current runtime attempt.
  const startedAtMs = Date.now();
  const ambient = getCurrentSessionControllerOwner();
  const operation =
    params.replyOperation ??
    (ambient && ambient.key === params.sessionKey && ambient.hasOwnedSessionId(params.sessionId)
      ? ambient
      : undefined);
  const controller = new AbortController();
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, controller.signal])
    : controller.signal;
  let current: DeferredEmbeddedRunLifecycleOwner | undefined;
  const discarded: Promise<void>[] = [];
  const replaceOwner = (owner?: DeferredEmbeddedRunLifecycleOwner) => {
    const previous = current;
    current = owner;
    const cleanup = previous?.discard();
    if (cleanup) {
      void cleanup.catch(() => {});
      discarded.push(cleanup);
    }
  };
  const abort = (reason?: "user_abort" | "restart" | "superseded") => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(
      reason === "restart"
        ? createAgentRunRestartAbortError()
        : reason === "superseded"
          ? createAgentRunSupersededAbortError()
          : createAgentRunDirectAbortError(),
    );
  };
  let cliOwner: EmbeddedAgentQueueHandle | undefined;
  let cliAttachment: ReturnType<typeof attachActiveEmbeddedRun>;
  const clearCliOwner = () => {
    if (cliOwner) {
      detachActiveEmbeddedRun(
        params.sessionId,
        cliOwner,
        params.sessionKey,
        params.sessionFile,
        undefined,
        cliAttachment,
      );
    }
  };
  return {
    signal,
    abort,
    adopt: replaceOwner,
    beginRetryWait: (deadlineAtMs, retrySignal, wait) =>
      current?.beginRetryWait(
        deadlineAtMs,
        retrySignal ? AbortSignal.any([signal, retrySignal]) : signal,
        wait,
      ),
    handoffToCli: () => {
      const diagnosticOwner = createDiagnosticEmbeddedRunOwner({
        ...params,
        watchdogAttempt: operation
          ? operation.watchdog.attachAttempt({
              assertCurrent: () => {
                signal.throwIfAborted();
                assertSessionControllerOperation(operation);
              },
            })
          : undefined,
      });
      // Each handoff gets a fresh owner; retained callbacks from a prior CLI
      // attempt must not publish progress after replacement or lifecycle rotation.
      cliOwner = {
        kind: "embedded",
        runId: params.runId,
        startedAtMs,
        diagnosticOwner,
        closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(diagnosticOwner),
        queueMessage: async () => {
          throw new Error("active run is switching runtimes");
        },
        isStreaming: () => false,
        isStopped: () => signal.aborted,
        isAborted: () => signal.aborted,
        isAbortable: () => !signal.aborted,
        isCompacting: () => false,
        cancel: abort,
        abort,
      };
      cliAttachment = attachActiveEmbeddedRun(
        params.sessionId,
        cliOwner,
        params.sessionKey,
        params.sessionFile,
        params.agentId,
        operation,
      );
      replaceOwner();
      return diagnosticOwner;
    },
    complete: async () => {
      const owner = current;
      current = undefined;
      try {
        await Promise.all([...discarded, owner?.complete()]);
      } finally {
        if (cliOwner) {
          clearCliOwner();
        }
      }
    },
  };
}
