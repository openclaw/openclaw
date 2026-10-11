import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveReplyOperationAbortReason } from "../../../auto-reply/reply/reply-operation-abort.js";
import {
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  closeDiagnosticEmbeddedRunOwner,
} from "../../../logging/diagnostic-run-activity.js";
import {
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../run-termination.js";
import {
  buildTurnSendLedgerSessionKey,
  commitTurnSend,
  peekTurnSendCount,
  reserveTurnSend,
} from "../../tools/turn-send-ledger.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  resolveActiveEmbeddedRunOwner,
  setActiveEmbeddedRun,
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
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
    handles.length = 0;
  });

  it.each([{ label: "omitted", reason: undefined }])(
    "classifies $label cancellation when the caller signal stays live",
    ({ reason }) => {
      const caller = new AbortController();
      const manager = createDeferredEmbeddedRunLifecycleManager({
        runId: "cancelled-logical-run",
        sessionId,
        sessionKey,
        abortSignal: caller.signal,
      });

      manager.abort(reason);

      expect(caller.signal.aborted).toBe(false);
      expect(resolveReplyOperationAbortReason(undefined, manager.signal.reason)).toBe("user");
      expect(resolveAgentRunErrorLifecycleFields(manager.signal.reason, caller.signal)).toEqual({
        aborted: true,
        stopReason: "aborted",
      });
    },
  );

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

  it("keeps a retained send-ledger slot until the logical turn completes", async () => {
    const runId = "ledger-retaining-logical-run";
    const scope = { agentId: "main", sessionKey, runId };
    const key = {
      sessionKey: buildTurnSendLedgerSessionKey(scope.agentId, scope.sessionKey)!,
      runId,
      targetKey: "imessage\0default\0+15550001111",
    };
    const reserved = reserveTurnSend(key, {});
    if (reserved.status !== "reserved") {
      throw new Error(`expected a reserved send, got "${reserved.status}"`);
    }
    commitTurnSend(reserved.reservation);
    const manager = createDeferredEmbeddedRunLifecycleManager({ runId, sessionId, sessionKey });

    manager.retainTurnSendLedgerScope(scope);
    expect(peekTurnSendCount(key)).toBe(1);

    await manager.complete();
    expect(peekTurnSendCount(key)).toBe(0);
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
    setActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey);
    const clearEmbedded = vi.fn(() =>
      clearActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey),
    );
    const manager = createDeferredEmbeddedRunLifecycleManager({
      runId: "logical-run",
      sessionId,
      sessionKey,
    });
    manager.adopt({
      beginRetryWait: () => undefined,
      complete: async () => clearEmbedded(),
      discard: clearEmbedded,
    });

    manager.handoffToCli();

    expect(clearEmbedded).toHaveBeenCalledOnce();
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(manager.signal.aborted).toBe(true);
    await manager.complete();
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(false);
    expect(resolveReplyOperationAbortReason(undefined, manager.signal.reason)).toBe("user");
  });

  it("keeps the logical turn start time on the CLI owner", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const manager = createDeferredEmbeddedRunLifecycleManager({
        runId: "long-cli-run",
        sessionId,
        sessionKey,
      });
      // Embedded preparation and fallback can run long before the CLI takes over.
      vi.setSystemTime(1_000_000 + 5 * 60_000);

      manager.handoffToCli();

      expect(resolveActiveEmbeddedRunOwner(sessionId)?.startedAtMs).toBe(1_000_000);
      await manager.complete();
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
    discarded.discard();
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
    expect(flush).toHaveBeenCalledOnce();
    expect(clearActiveRun).toHaveBeenCalledTimes(2);
  });

  it.each(["abort", "timeout", "complete", "replace", "close", "authority"] as const)(
    "releases a retry wait when its owner loses authority through %s",
    async (reason) => {
      const ref = { runId: "waiting-run", sessionId, sessionKey };
      const diagnosticOwner = createDiagnosticEmbeddedRunOwner(ref);
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
      }
    },
  );

  it("does not let a completed wait release its owner's next wait", async () => {
    const ref = { runId: "reused-wait-owner", sessionId, sessionKey };
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner(ref);
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
      const releaseFirst = manager.beginRetryWait(Date.now() + 660_000);
      const nextDeadline = Date.now() + 900_000;
      const releaseNext = manager.beginRetryWait(nextDeadline);
      releaseFirst?.();
      expect(getDiagnosticSessionActivitySnapshot(ref).activeRetryWaitDeadlineAtMs).toBe(
        nextDeadline,
      );
      releaseNext?.();
      expect(getDiagnosticSessionActivitySnapshot(ref).activeRetryWaitDeadlineAtMs).toBeUndefined();
    } finally {
      await manager.complete();
    }
  });
});
