import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveReplyOperationAbortReason } from "../../../auto-reply/reply/reply-operation-abort.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../../infra/diagnostic-events.js";
import {
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  closeDiagnosticEmbeddedRunOwner,
} from "../../../logging/diagnostic-run-activity.js";
import { getDiagnosticSessionState } from "../../../logging/diagnostic-session-state.js";
import { resetDiagnosticStateForTest } from "../../../logging/diagnostic.test-support.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import { isSessionRunActive } from "../../../sessions/session-controller.queries.js";
import { assertSessionControllerOperation } from "../../../sessions/session-controller.state.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { attachCliReplyBackend } from "../../cli-runner/execution-target.js";
import { runWithCliTurn } from "../../cli-runner/turn-admission.js";
import {
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../run-termination.js";
import { getActiveNativeAttempt } from "../run-state.js";
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
  const managerFor = (
    runId: string,
    overrides: Partial<Parameters<typeof createDeferredEmbeddedRunLifecycleManager>[0]> = {},
  ) => createDeferredEmbeddedRunLifecycleManager({ runId, sessionId, sessionKey, ...overrides });
  const ownerFor = (
    runId: string,
    overrides: Partial<Parameters<typeof createEmbeddedAttemptDeferredLifecycleOwner>[0]>,
  ) =>
    createEmbeddedAttemptDeferredLifecycleOwner({
      runId,
      sessionId,
      diagnosticOwner:
        overrides.diagnosticOwner ?? createDiagnosticEmbeddedRunOwner({ runId, sessionId }),
      isCurrent: () => true,
      onRetryWaitCompleted: () => {},
      trajectoryRecorder: null,
      clearActiveRun: () => {},
      ...overrides,
    });
  const idleOwner = () => ({
    beginRetryWait: () => undefined,
    complete: async () => {},
    discard: () => {},
  });
  const retryManager = (
    runId: string,
    overrides: Partial<Parameters<typeof createEmbeddedAttemptDeferredLifecycleOwner>[0]> = {},
  ) => {
    const ref = { runId, sessionId, sessionKey };
    const operation = createReplyOperation({ ...ref, resetTriggered: false });
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner({
      ...ref,
      watchdogAttempt: operation.watchdog.attachAttempt({
        assertCurrent: () => assertSessionControllerOperation(operation),
      }),
    });
    markDiagnosticEmbeddedRunStarted({ ...ref, owner: diagnosticOwner });
    const manager = managerFor(runId);
    const owner = ownerFor(runId, {
      diagnosticOwner,
      clearActiveRun: () => closeDiagnosticEmbeddedRunOwner(diagnosticOwner),
      ...overrides,
    });
    manager.adopt(owner);
    return { ref, operation, diagnosticOwner, manager, owner };
  };

  afterEach(() => {
    for (const handle of handles) {
      detachActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
    handles.length = 0;
    vi.restoreAllMocks();
  });

  it.each(["complete", "discard"] as const)(
    "releases completed attempt callbacks and terminal data after %s",
    async (settle) => {
      class SessionPayload {
        active = true;
      }
      const createOwner = () => {
        const payload = new SessionPayload();
        const owner = ownerFor("retained-owner", {
          isCurrent: () => payload.active,
          onRetryWaitCompleted: () => {
            payload.active = true;
          },
          clearActiveRun: () => {
            payload.active = false;
          },
        });
        owner.recordSessionEnd({ payload });
        return owner;
      };
      const active = createOwner();
      const completed = [];
      for (let index = 0; index < 20; index++) {
        const owner = createOwner();
        await owner[settle]();
        completed.push(owner);
      }
      // Count after the last awaited cleanup frame leaves the current job.
      await nextTurn();
      expect(queryObjects(SessionPayload)).toBe(1);
      await active[settle]();
      await nextTurn();
      expect(queryObjects(SessionPayload)).toBe(0);
      for (const owner of completed) {
        await owner[settle]();
      }
    },
  );

  it.each([false, true])("preserves the first caller cancellation (timeout=%s)", (timedOut) => {
    const caller = new AbortController();
    const manager = managerFor("cancelled-logical-run", { abortSignal: caller.signal });
    const timeout = new DOMException("Run deadline reached", "TimeoutError");
    if (timedOut) {
      caller.abort(timeout);
    }
    manager.abort(timedOut ? "user_abort" : undefined);
    expect(caller.signal.aborted).toBe(timedOut);
    if (timedOut) {
      expect(manager.signal.reason).toBe(timeout);
    } else {
      expect(resolveReplyOperationAbortReason(undefined, manager.signal.reason)).toBe("user");
    }
    expect(resolveAgentRunErrorLifecycleFields(manager.signal.reason, caller.signal)).toEqual({
      aborted: true,
      stopReason: timedOut ? "timeout" : "aborted",
    });
  });

  it.each([
    { reason: "restart" as const, matchesReason: isAgentRunRestartAbortReason },
    { reason: "superseded" as const, matchesReason: isAgentRunSupersededAbortReason },
  ])("keeps the first $reason reason after another abort", ({ reason, matchesReason }) => {
    const manager = managerFor("interrupted-logical-run");

    manager.abort(reason);
    manager.abort("user_abort");

    expect(matchesReason(manager.signal.reason)).toBe(true);
  });

  it("hands the original logical turn and cancellation authority to CLI before releasing the embedded attempt", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const embeddedHandle = runHandle("logical-run");
    handles.push(embeddedHandle);
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    attachActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey, undefined, undefined, operation);
    const clearEmbedded = vi.fn(() =>
      detachActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey),
    );
    const manager = managerFor("logical-run", { replyOperation: operation });
    manager.adopt({
      beginRetryWait: () => undefined,
      complete: async () => clearEmbedded(),
      discard: clearEmbedded,
    });

    clock.mockReturnValue(1_300_000);
    manager.handoffToCli();

    expect(resolveActiveEmbeddedRunOwner(sessionId)?.startedAtMs).toBe(1_000_000);
    expect(clearEmbedded).toHaveBeenCalledOnce();
    expect(isSessionRunActive(sessionId)).toBe(true);
    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(manager.signal.aborted).toBe(true);
    await manager.complete();
    operation.complete();
    expect(isSessionRunActive(sessionId)).toBe(false);
    expect(resolveReplyOperationAbortReason(undefined, manager.signal.reason)).toBe("user");
  });

  it("keeps native ownership through CLI backend cleanup and returns the completed turn to idle", async () => {
    const diagnosticsEnabled = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    try {
      await withSessionTurn({ sessionId, sessionKey }, async (operation) => {
        const manager = managerFor("cli-owned-turn", { replyOperation: operation });
        try {
          const diagnosticOwner = manager.handoffToCli();
          const native = getActiveNativeAttempt(sessionId);
          expect(native).toBeDefined();
          expect(getDiagnosticSessionState({ sessionId, sessionKey }).state).toBe("processing");

          await runWithCliTurn(
            {
              sessionId,
              sessionKey,
              sessionFile: "cli-owned-turn.jsonl",
              workspaceDir: ".",
              prompt: "Reply with exactly: pong",
              provider: "claude-cli",
              runId: "cli-owned-turn",
              timeoutMs: 10_000,
              replyOperation: operation,
              diagnosticOwner,
            },
            async (params) => {
              const detach = attachCliReplyBackend(params, () => {});
              try {
                expect.soft(getActiveNativeAttempt(sessionId)).toBe(native);
              } finally {
                detach?.();
              }
              expect.soft(getActiveNativeAttempt(sessionId)).toBe(native);
              expect(getDiagnosticSessionState({ sessionId, sessionKey }).state).toBe("processing");
              return { payloads: [{ text: "pong" }], meta: { durationMs: 0 } };
            },
          );
        } finally {
          await manager.complete();
        }
        expect.soft(getDiagnosticSessionState({ sessionId, sessionKey }).state).toBe("idle");
        expect(getActiveNativeAttempt(sessionId)).toBeUndefined();
      });
      expect(isSessionRunActive(sessionId)).toBe(false);
      expect(getDiagnosticSessionState({ sessionId, sessionKey }).state).toBe("idle");
    } finally {
      resetDiagnosticStateForTest();
      setDiagnosticsEnabledForProcess(diagnosticsEnabled);
    }
  });

  it("releases a discarded candidate immediately and joins its diagnostic flush at completion", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const recordEvent = vi.fn();
    const clearActiveRun = vi.fn();
    const manager = managerFor("replaced-candidate", { sessionKey: undefined });
    const discarded = ownerFor("replaced-candidate", {
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
    manager.adopt(idleOwner());
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

  it("flushes retry diagnostics without publishing the terminal trajectory until completion", async () => {
    const flushed = createDeferredCore();
    const recordEvent = vi.fn();
    const { manager, operation, owner } = retryManager("retry-candidate", {
      trajectoryRecorder: {
        recordEvent,
        describeFlushState: () => "pendingRows=1",
        flush: async () => flushed.resolve(),
      },
    });
    owner.recordSessionEnd({ status: "success" });
    const release = manager.beginRetryWait(Date.now() + 660_000);
    try {
      await flushed.promise;
      expect(recordEvent).not.toHaveBeenCalled();
    } finally {
      release?.();
      await manager.complete();
      operation.complete();
    }
    expect(recordEvent.mock.calls).toEqual([["session.ended", { status: "success" }]]);
  });

  it.each(["abort", "timeout", "complete", "replace", "close", "authority", "next-wait"] as const)(
    "keeps retry waits bound to their owner through %s",
    async (reason) => {
      let current = true;
      const onRetryWaitCompleted = vi.fn();
      const { ref, operation, diagnosticOwner, manager } = retryManager("waiting-run", {
        isCurrent: () => current,
        onRetryWaitCompleted,
      });
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
          manager.adopt(idleOwner());
        } else if (reason === "close") {
          closeDiagnosticEmbeddedRunOwner(diagnosticOwner);
        } else if (reason === "authority") {
          current = false;
        } else {
          const releaseNext = manager.beginRetryWait(deadlineAtMs + 240_000);
          release?.();
          expect(getDiagnosticSessionActivitySnapshot(ref).activeRetryWaitDeadlineAtMs).toBe(
            deadlineAtMs,
          );
          releaseNext?.();
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
});
