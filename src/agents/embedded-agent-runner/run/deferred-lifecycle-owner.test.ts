import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveReplyOperationAbortReason } from "../../../auto-reply/reply/reply-operation-abort.js";
import {
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../run-termination.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
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

  it.each([
    { label: "omitted", reason: undefined },
    { label: "explicit user", reason: "user_abort" as const },
  ])("classifies $label cancellation when the caller signal stays live", ({ reason }) => {
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
    setActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey);
    const clearEmbedded = vi.fn(() =>
      clearActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey),
    );
    const manager = createDeferredEmbeddedRunLifecycleManager({
      runId: "logical-run",
      sessionId,
      sessionKey,
    });
    manager.adopt({ complete: async () => clearEmbedded(), discard: clearEmbedded });

    manager.handoffToCli();

    expect(clearEmbedded).toHaveBeenCalledOnce();
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(manager.signal.aborted).toBe(true);
    await manager.complete();
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(false);
    expect(resolveReplyOperationAbortReason(undefined, manager.signal.reason)).toBe("user");
  });

  it("records only the accepted candidate terminal trajectory", async () => {
    const recordEvent = vi.fn();
    const flush = vi.fn(async () => undefined);
    const clearActiveRun = vi.fn();
    const discarded = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: "logical-run",
      sessionId,
      trajectoryRecorder: { recordEvent, flush, describeFlushState: () => undefined },
      clearActiveRun,
    });
    discarded.recordSessionEnd({ status: "error" });
    discarded.discard();
    expect(recordEvent).not.toHaveBeenCalled();

    const accepted = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: "logical-run",
      sessionId,
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
});
