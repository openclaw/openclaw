import { formatErrorMessage } from "../../../infra/errors.js";
import {
  beginDiagnosticRetryWait,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  type DiagnosticEmbeddedRunOwner,
} from "../../../logging/diagnostic-run-activity.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "../../run-termination.js";
import { log } from "../logger.js";
import type { EmbeddedAgentQueueHandle } from "../run-state.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../runs.js";
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
  ) => ((completed?: boolean) => void) | undefined;
  complete: () => Promise<void>;
  discard: () => void;
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
  let state: "pending" | "completed" | "discarded" = "pending";
  let sessionEndData: Record<string, unknown> | undefined;
  let closeRetryWait: (() => void) | undefined;
  const releaseRetryWait = () => {
    closeRetryWait?.();
    closeRetryWait = undefined;
  };
  const releaseActiveRun = () => {
    try {
      params.clearActiveRun();
    } catch (error) {
      log.error(
        `CRITICAL: deferred active run cleanup failed, possible resource leak: ` +
          `runId=${params.runId} ${formatErrorMessage(error)}`,
      );
    }
  };
  return {
    beginRetryWait: (deadlineAtMs, signal) => {
      if (state !== "pending") {
        return undefined;
      }
      releaseRetryWait();
      const close = beginDiagnosticRetryWait({
        owner: params.diagnosticOwner,
        deadlineAtMs,
        signal,
        assertCurrent: () => {
          if (!params.isCurrent()) {
            throw createAgentRunSupersededAbortError();
          }
        },
      });
      closeRetryWait = close;
      return (completed) => {
        if (close(completed)) {
          params.onRetryWaitCompleted();
        }
        if (closeRetryWait === close) {
          closeRetryWait = undefined;
        }
      };
    },
    recordSessionEnd: (data) => {
      if (state === "pending") {
        sessionEndData = data;
      }
    },
    discard: () => {
      if (state !== "pending") {
        return;
      }
      state = "discarded";
      releaseRetryWait();
      releaseActiveRun();
    },
    complete: async () => {
      if (state !== "pending") {
        return;
      }
      state = "completed";
      releaseRetryWait();
      try {
        if (params.trajectoryRecorder && sessionEndData) {
          params.trajectoryRecorder.recordEvent("session.ended", sessionEndData);
          await flushEmbeddedAttemptTrajectoryRecorder({
            runId: params.runId,
            sessionId: params.sessionId,
            trajectoryRecorder: params.trajectoryRecorder,
            log,
          });
        }
      } finally {
        releaseActiveRun();
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
  ) => ((completed?: boolean) => void) | undefined;
  handoffToCli: () => DiagnosticEmbeddedRunOwner;
  complete: () => Promise<void>;
};

export function createDeferredEmbeddedRunLifecycleManager(params: {
  runId: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  abortSignal?: AbortSignal;
}): DeferredEmbeddedRunLifecycleManager {
  const controller = new AbortController();
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, controller.signal])
    : controller.signal;
  let current: DeferredEmbeddedRunLifecycleOwner | undefined;
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
  const clearCliOwner = () => {
    if (cliOwner) {
      clearActiveEmbeddedRun(params.sessionId, cliOwner, params.sessionKey, params.sessionFile);
    }
  };
  return {
    signal,
    abort,
    adopt: (owner) => {
      const previous = current;
      current = owner;
      previous?.discard();
    },
    beginRetryWait: (deadlineAtMs, retrySignal) =>
      current?.beginRetryWait(
        deadlineAtMs,
        retrySignal ? AbortSignal.any([signal, retrySignal]) : signal,
      ),
    handoffToCli: () => {
      const diagnosticOwner = createDiagnosticEmbeddedRunOwner(params);
      // Each handoff gets a fresh owner; retained callbacks from a prior CLI
      // attempt must not publish progress after replacement or lifecycle rotation.
      cliOwner = {
        kind: "embedded",
        runId: params.runId,
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
      setActiveEmbeddedRun(
        params.sessionId,
        cliOwner,
        params.sessionKey,
        params.sessionFile,
        params.agentId,
      );
      const previous = current;
      current = undefined;
      previous?.discard();
      return diagnosticOwner;
    },
    complete: async () => {
      const owner = current;
      current = undefined;
      try {
        await owner?.complete();
      } finally {
        clearCliOwner();
      }
    },
  };
}
