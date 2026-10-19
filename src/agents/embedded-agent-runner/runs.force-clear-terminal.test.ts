import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.state.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import { getActiveNativeAttempt } from "./run-state.js";
import {
  abortAndDrainEmbeddedAgentRun,
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "./runs.js";
import { createEmbeddedRunHandle, testing } from "./runs.test-support.js";

const key = "agent:main:retained-native-cleanup";
const sessionId = "retained-native-incarnation";
const stalledAt = 6 * 60_000;
function begin(cancel: () => void) {
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  operation.setPhase("running");
  const handle = createEmbeddedRunHandle({ runId: "native", abort: cancel });
  attachActiveEmbeddedRun(sessionId, handle, key, undefined, undefined, operation);
  return { operation, handle };
}
function recover() {
  return abortAndDrainEmbeddedAgentRun({
    sessionId,
    sessionKey: key,
    settleMs: 10,
    forceClear: true,
    reason: "stuck_recovery",
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
  vi.useRealTimers();
});

describe("native watchdog cleanup retains actual writer custody", () => {
  it("does not settle a detached native producer merely because its lifecycle rotates", async () => {
    const first = createEmbeddedRunHandle({ runId: "detached-first" });
    const second = createEmbeddedRunHandle({ runId: "detached-second" });
    attachActiveEmbeddedRun(sessionId, first);
    let settled = false;
    const waiting = waitForSessionRunEnd(sessionId, null).then((ended) => {
      settled = true;
      return ended;
    });
    try {
      rotateAgentEventLifecycleGeneration();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      attachActiveEmbeddedRun(sessionId, second);
      detachActiveEmbeddedRun(sessionId, first);
      await expect(waiting).resolves.toBe(true);
      expect(getActiveNativeAttempt(sessionId)).toBe(second);
    } finally {
      detachActiveEmbeddedRun(sessionId, first);
      detachActiveEmbeddedRun(sessionId, second);
      await waiting;
    }
  });

  it.each(["ignored", "throws"] as const)(
    "does not release a writer or successor when cancellation is %s",
    async (kind) => {
      const cancelled = createDeferred();
      const cancel = vi.fn(() => {
        cancelled.resolve();
        if (kind === "throws") {
          throw new Error("writer still live");
        }
      });
      const { operation, handle } = begin(cancel);
      const dispatch = vi.fn(async () => "next");
      const successor = withSessionTurn({ sessionKey: key, sessionId }, dispatch);
      vi.setSystemTime(stalledAt);
      const recovery = recover();
      await cancelled.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(await recovery).toMatchObject({ drained: false, forceCleared: false });
      expect(cancel).toHaveBeenCalledOnce();
      expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
      expect(getActiveNativeAttempt(sessionId)).toBe(handle);
      expect(getSessionControllerOperation(key)).toBe(operation);
      expect(dispatch).not.toHaveBeenCalled();
      detachActiveEmbeddedRun(sessionId, handle, key);
      operation.complete();
      await expect(successor).resolves.toBe("next");
    },
  );

  it("does not infer raw owner settlement from native handle removal", async () => {
    const writer = createDeferred();
    const { operation, handle } = begin(() => detachActiveEmbeddedRun(sessionId, handle, key));
    vi.setSystemTime(stalledAt);
    const releaseExecution = operation.retainExecution();
    void writer.promise.then(releaseExecution);
    const recovery = recover();
    operation.complete();
    await vi.advanceTimersByTimeAsync(100);
    expect(await recovery).toMatchObject({ drained: false, forceCleared: false });
    const dispatch = vi.fn(async () => "next");
    const successor = withSessionTurn({ sessionKey: key, sessionId }, dispatch);
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    writer.resolve();
    await operation.ownerSettlement;
    await successor;
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("preserves frozen output on cleanup expiry instead of persisting a killed terminal result", async () => {
    const { operation, handle } = begin(() => {
      operation.supersede();
      operation.fail("run_failed");
    });
    operation.freezeAbort();
    vi.setSystemTime(60_001);
    const recovery = recover();
    await vi.advanceTimersByTimeAsync(100);
    expect(await recovery).toMatchObject({ drained: false, forceCleared: false });
    expect(operation.result).toBeNull();
    detachActiveEmbeddedRun(sessionId, handle, key);
    operation.complete();
    expect(operation.result).toEqual({ kind: "completed" });
  });

  it("cannot cancel or clear a successor installed by the captured owner's synchronous completion", async () => {
    const nextCancel = vi.fn();
    let successor: ReturnType<typeof begin> | undefined;
    const old = begin(() => {
      detachActiveEmbeddedRun(sessionId, old.handle, key);
      old.operation.complete();
      successor = begin(nextCancel);
    });
    vi.setSystemTime(stalledAt);
    expect(await recover()).toMatchObject({ drained: true, forceCleared: false });
    expect(getSessionControllerOperation(key)).toBe(successor?.operation);
    expect(getActiveNativeAttempt(sessionId)).toBe(successor?.handle);
    expect(nextCancel).not.toHaveBeenCalled();
    detachActiveEmbeddedRun(sessionId, successor!.handle, key);
    successor!.operation.complete();
  });
});
