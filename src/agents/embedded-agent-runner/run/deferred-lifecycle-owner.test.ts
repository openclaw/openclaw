import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveReplyOperationAbortReason } from "../../../auto-reply/reply/reply-operation-abort.js";
import {
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  closeDiagnosticEmbeddedRunOwner,
} from "../../../logging/diagnostic-run-activity.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import { isSessionRunActive } from "../../../sessions/session-controller.queries.js";
import { assertSessionControllerOperation } from "../../../sessions/session-controller.state.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../run-termination.js";
import {
  abortEmbeddedAgentRun,
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
  resolveActiveEmbeddedRunOwner,
  type EmbeddedAgentQueueHandle,
} from "../runs.js";
import {
  createDeferredEmbeddedRunLifecycleManager,
  createEmbeddedAttemptDeferredLifecycleOwner,
} from "./deferred-lifecycle-owner.js";

function runHandle(runId: string): EmbeddedAgentQueueHandle {
  return {
    runId,
    queueMessage: async () => undefined,
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
  };
}

describe("deferred logical-turn lifecycle", () => {
  const sessionId = "deferred-lifecycle-session";
  const sessionKey = "agent:main:deferred-lifecycle";
  const handles: EmbeddedAgentQueueHandle[] = [];

  afterEach(() => {
    for (const handle of handles) {
      detachActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
    handles.length = 0;
  });

  it("classifies omitted cancellation when the caller signal stays live", () => {
    const caller = new AbortController();
    const manager = createDeferredEmbeddedRunLifecycleManager({
      runId: "cancelled-logical-run",
      sessionId,
      sessionKey,
      abortSignal: caller.signal,
    });

    manager.abort(undefined);

    expect(caller.signal.aborted).toBe(false);
    expect(resolveReplyOperationAbortReason(undefined, manager.signal.reason)).toBe("user");
    expect(resolveAgentRunErrorLifecycleFields(manager.signal.reason, caller.signal)).toEqual({
      aborted: true,
      stopReason: "aborted",
    });
  });

  it.each([
    { reason: "restart" as const, matchesReason: isAgentRunRestartAbortReason },
    { reason: "superseded" as const, matchesReason: isAgentRunSupersededAbortReason },
  ])("keeps the first $reason reason after another abort", ({ reason, matchesReason }) => {
    const manager = createDeferredEmbeddedRunLifecycleManager({
      runId: "interrupted-logical-run",
      sessionId,
      sessionKey,
    });

    manager.abort(reason);
    manager.abort("user_abort");

    expect(matchesReason(manager.signal.reason)).toBe(true);
  });

  it("preserves an earlier caller timeout when a user abort arrives later", () => {
    const caller = new AbortController();
    const manager = createDeferredEmbeddedRunLifecycleManager({
      runId: "timed-out-logical-run",
      sessionId,
      sessionKey,
      abortSignal: caller.signal,
    });
    const timeout = new DOMException("Run deadline reached", "TimeoutError");

    caller.abort(timeout);
    manager.abort("user_abort");

    expect(manager.signal.reason).toBe(timeout);
    expect(resolveAgentRunErrorLifecycleFields(manager.signal.reason, caller.signal)).toEqual({
      aborted: true,
      stopReason: "timeout",
    });
  });

  it("publishes CLI cancellation authority before releasing the embedded attempt", async () => {
    const embeddedHandle = runHandle("logical-run");
    handles.push(embeddedHandle);
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    attachActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey, undefined, undefined, operation);
    const clearEmbedded = vi.fn(() =>
      detachActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey),
    );
    const manager = createDeferredEmbeddedRunLifecycleManager({
      runId: "logical-run",
      sessionId,
      sessionKey,
      replyOperation: operation,
    });
    manager.adopt({
      beginRetryWait: () => undefined,
      complete: async () => clearEmbedded(),
      discard: clearEmbedded,
    });

    manager.handoffToCli();

    expect(clearEmbedded).toHaveBeenCalledOnce();
    expect(isSessionRunActive(sessionId)).toBe(true);
    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(manager.signal.aborted).toBe(true);
    await manager.complete();
    operation.complete();
    expect(isSessionRunActive(sessionId)).toBe(false);
    expect(resolveReplyOperationAbortReason(undefined, manager.signal.reason)).toBe("user");
  });

  it("keeps the logical turn start time on the CLI owner", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
      const manager = createDeferredEmbeddedRunLifecycleManager({
        replyOperation: operation,
        runId: "long-cli-run",
        sessionId,
        sessionKey,
      });
      // Embedded preparation and fallback can run long before the CLI takes over.
      vi.setSystemTime(1_000_000 + 5 * 60_000);

      manager.handoffToCli();

      expect(resolveActiveEmbeddedRunOwner(sessionId)?.startedAtMs).toBe(1_000_000);
      await manager.complete();
      operation.complete();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records only the accepted candidate terminal trajectory", async () => {
    const recordEvent = vi.fn();
    const flush = vi.fn(async () => undefined);
    const clearActiveRun = vi.fn();
    const discarded = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: "logical-run",
      sessionId,
      diagnosticOwner: createDiagnosticEmbeddedRunOwner({ runId: "logical-run", sessionId }),
      isCurrent: () => true,
      onRetryWaitCompleted: () => {},
      trajectoryRecorder: { recordEvent, flush, describeFlushState: () => undefined },
      clearActiveRun,
    });
    discarded.recordSessionEnd({ status: "error" });
    await discarded.discard();
    expect(recordEvent).not.toHaveBeenCalled();

    const accepted = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: "logical-run",
      sessionId,
      diagnosticOwner: createDiagnosticEmbeddedRunOwner({ runId: "logical-run", sessionId }),
      isCurrent: () => true,
      onRetryWaitCompleted: () => {},
      trajectoryRecorder: { recordEvent, flush, describeFlushState: () => undefined },
      clearActiveRun,
    });
    accepted.recordSessionEnd({ status: "success" });
    await accepted.complete();

    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith("session.ended", { status: "success" });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(clearActiveRun).toHaveBeenCalledTimes(2);
  });

  it("releases a discarded candidate immediately and joins its diagnostic flush at completion", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const recordEvent = vi.fn();
    const clearActiveRun = vi.fn();
    const manager = createDeferredEmbeddedRunLifecycleManager({
      runId: "replaced-candidate",
      sessionId,
    });
    const discarded = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: "replaced-candidate",
      sessionId,
      diagnosticOwner: createDiagnosticEmbeddedRunOwner({ runId: "replaced-candidate", sessionId }),
      isCurrent: () => true,
      onRetryWaitCompleted: () => {},
      trajectoryRecorder: {
        recordEvent,
        describeFlushState: () => "pendingRows=1",
        flush: async () => {
          entered.resolve();
          await release.promise;
        },
      },
      clearActiveRun,
    });
    discarded.recordSessionEnd({ status: "success" });
    manager.adopt(discarded);
    manager.adopt({
      beginRetryWait: () => undefined,
      complete: async () => {},
      discard: () => {},
    });
    expect(clearActiveRun).toHaveBeenCalledOnce();
    expect(recordEvent).not.toHaveBeenCalled();
    await entered.promise;
    let settled = false;
    const completion = manager.complete().then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await completion;
    }
    expect(settled).toBe(true);
  });

  it("flushes buffered diagnostics when a successful candidate enters retry backoff", async () => {
    const ref = { runId: "retry-candidate", sessionId, sessionKey };
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner(ref);
    markDiagnosticEmbeddedRunStarted({ ...ref, owner: diagnosticOwner });
    const flushed = createDeferredCore();
    const recordEvent = vi.fn();
    const owner = createEmbeddedAttemptDeferredLifecycleOwner({
      ...ref,
      diagnosticOwner,
      isCurrent: () => true,
      onRetryWaitCompleted: () => {},
      trajectoryRecorder: {
        recordEvent,
        describeFlushState: () => "pendingRows=1",
        flush: async () => flushed.resolve(),
      },
      clearActiveRun: () => closeDiagnosticEmbeddedRunOwner(diagnosticOwner),
    });
    owner.recordSessionEnd({ status: "success" });
    const release = owner.beginRetryWait(Date.now() + 660_000, new AbortController().signal);
    try {
      await flushed.promise;
      expect(recordEvent).not.toHaveBeenCalled();
    } finally {
      release?.();
      await owner.discard();
    }
  });

  it.each(["abort", "timeout", "complete", "replace", "close", "authority"] as const)(
    "releases a retry wait when its owner loses authority through %s",
    async (reason) => {
      const ref = { runId: "waiting-run", sessionId, sessionKey };
      const operation = createReplyOperation({ ...ref, resetTriggered: false });
      const diagnosticOwner = createDiagnosticEmbeddedRunOwner({
        ...ref,
        watchdogAttempt: operation.watchdog.attachAttempt({
          assertCurrent: () => assertSessionControllerOperation(operation),
        }),
      });
      markDiagnosticEmbeddedRunStarted({ ...ref, owner: diagnosticOwner });
      let current = true;
      const onRetryWaitCompleted = vi.fn();
      const manager = createDeferredEmbeddedRunLifecycleManager(ref);
      manager.adopt(
        createEmbeddedAttemptDeferredLifecycleOwner({
          ...ref,
          diagnosticOwner,
          isCurrent: () => current,
          onRetryWaitCompleted,
          trajectoryRecorder: null,
          clearActiveRun: () => closeDiagnosticEmbeddedRunOwner(diagnosticOwner),
        }),
      );
      const timeout = new AbortController();
      const deadlineAtMs = Date.now() + 660_000;
      const release = manager.beginRetryWait(deadlineAtMs, timeout.signal);
      try {
        expect(getDiagnosticSessionActivitySnapshot(ref).activeRetryWaitDeadlineAtMs).toBe(
          deadlineAtMs,
        );
        if (reason === "abort") {
          manager.abort();
        } else if (reason === "timeout") {
          timeout.abort(new DOMException("Execution deadline reached", "TimeoutError"));
        } else if (reason === "complete") {
          await manager.complete();
        } else if (reason === "replace") {
          manager.adopt({
            beginRetryWait: () => undefined,
            complete: async () => {},
            discard: () => {},
          });
        } else if (reason === "close") {
          closeDiagnosticEmbeddedRunOwner(diagnosticOwner);
        } else {
          current = false;
        }
        expect(
          getDiagnosticSessionActivitySnapshot(ref).activeRetryWaitDeadlineAtMs,
        ).toBeUndefined();
      } finally {
        expect(onRetryWaitCompleted).not.toHaveBeenCalled();
        release?.();
        await manager.complete();
        operation.complete();
      }
    },
  );

  it("does not let a completed wait release its owner's next wait or renew its horizon", async () => {
    const ref = { runId: "reused-wait-owner", sessionId, sessionKey };
    const operation = createReplyOperation({ ...ref, resetTriggered: false });
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner({
      ...ref,
      watchdogAttempt: operation.watchdog.attachAttempt({
        assertCurrent: () => assertSessionControllerOperation(operation),
      }),
    });
    markDiagnosticEmbeddedRunStarted({ ...ref, owner: diagnosticOwner });
    const manager = createDeferredEmbeddedRunLifecycleManager(ref);
    manager.adopt(
      createEmbeddedAttemptDeferredLifecycleOwner({
        ...ref,
        diagnosticOwner,
        isCurrent: () => true,
        onRetryWaitCompleted: () => {},
        trajectoryRecorder: null,
        clearActiveRun: () => closeDiagnosticEmbeddedRunOwner(diagnosticOwner),
      }),
    );
    try {
      const firstDeadline = Date.now() + 660_000;
      const releaseFirst = manager.beginRetryWait(firstDeadline);
      const nextDeadline = Date.now() + 900_000;
      const releaseNext = manager.beginRetryWait(nextDeadline);
      releaseFirst?.();
      expect(getDiagnosticSessionActivitySnapshot(ref).activeRetryWaitDeadlineAtMs).toBe(
        firstDeadline,
      );
      releaseNext?.();
      expect(getDiagnosticSessionActivitySnapshot(ref).activeRetryWaitDeadlineAtMs).toBeUndefined();
    } finally {
      await manager.complete();
      operation.complete();
    }
  });
});
