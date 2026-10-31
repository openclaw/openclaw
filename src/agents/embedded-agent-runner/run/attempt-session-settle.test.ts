import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import {
  clearEmbeddedSessionPromptStates,
  retainEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import {
  cleanupEmbeddedAttemptSessionPhase,
  createEmbeddedAttemptSessionResources,
  createEmbeddedAttemptSessionSettleTracker,
} from "./attempt-session-settle.js";
import { createEmbeddedAttemptDeferredLifecycleOwner } from "./deferred-lifecycle-owner.js";

it("releases prompt payloads while completed attempts' resource owners remain reachable", () => {
  class PromptPayload extends Set<string> {}
  let sequence = 0;
  const createRetainedReview = (release: boolean) => {
    const owner = createEmbeddedAttemptSessionResources(new AbortController().signal);
    const lease = retainEmbeddedSessionPromptState(`retained-review-${sequence++}`);
    lease.state.removedRuntimeContextKeys = new PromptPayload(["runtime-context"]);
    owner.resources.promptStateLease = lease;
    if (release) {
      owner.takeForCleanup();
    }
    lease[Symbol.dispose]();
    return owner;
  };
  const callbacks = [createRetainedReview(false)];
  try {
    callbacks.push(...Array.from({ length: 32 }, () => createRetainedReview(true)));
    expect(queryObjects(PromptPayload)).toBe(1);
    callbacks.shift();
    expect(queryObjects(PromptPayload)).toBe(0);
  } finally {
    callbacks.length = 0;
  }
});

it.each([false, true])(
  "unloads prompt state when session teardown settles (cleanup failure=%s)",
  async (fails) => {
    const sessionId = `session-prompt-cleanup-${fails}`;
    const lease = retainEmbeddedSessionPromptState(sessionId);
    const entered = deferred();
    const finish = deferred();
    const cleanup = cleanupEmbeddedAttemptSessionPhase({
      attempt: { sessionId, runId: "prompt-cleanup" },
      promptStateLease: lease,
      trajectoryRecorder: null,
      trajectoryEndRecorded: false,
      buildAbortSettlePromise: () => null,
      state: { terminal: { kind: "ok" }, beforeAgentRunBlockedBy: undefined },
      transcriptLifecycle: {
        beginCleanup: async () => {},
        dispose: async () => {
          entered.resolve();
          await finish.promise;
          if (fails) {
            throw new Error("cleanup failed");
          }
        },
      },
    });
    const outcome = cleanup.catch((error: unknown) => error);
    try {
      await entered.promise;
      {
        using duringCleanup = retainEmbeddedSessionPromptState(sessionId);
        expect(duringCleanup.state).toBe(lease.state);
      }
      finish.resolve();
      expect(await outcome).toEqual(fails ? new Error("cleanup failed") : undefined);
      using afterCleanup = retainEmbeddedSessionPromptState(sessionId);
      expect(afterCleanup.state).not.toBe(lease.state);
    } finally {
      finish.resolve();
      await outcome;
      clearEmbeddedSessionPromptStates([sessionId]);
    }
  },
);

it.each([
  { kind: "failed", source: "prompt", error: new Error("provider failed") } as const,
  { kind: "aborted", source: "external" } as const,
])("keeps the $kind attempt's diagnostic checkpoint before teardown", async (terminal) => {
  const sessionId = `trajectory-checkpoint-${terminal.kind}`;
  const recorder = {
    enabled: true as const,
    recordEvent: vi.fn(),
    describeFlushState: () => undefined,
    flush: vi.fn(async () => {}),
  };
  const owner = createEmbeddedAttemptDeferredLifecycleOwner({
    runId: sessionId,
    sessionId,
    diagnosticOwner: createDiagnosticEmbeddedRunOwner({ runId: sessionId, sessionId }),
    isCurrent: () => true,
    onRetryWaitCompleted: () => {},
    trajectoryRecorder: recorder,
    clearActiveRun: () => {},
  });
  await cleanupEmbeddedAttemptSessionPhase({
    attempt: { sessionId, runId: sessionId },
    trajectoryRecorder: recorder,
    trajectoryEndRecorded: false,
    deferredLifecycleOwner: owner,
    buildAbortSettlePromise: () => null,
    state: { terminal, beforeAgentRunBlockedBy: undefined },
    transcriptLifecycle: {
      beginCleanup: async () => {
        expect(recorder.flush).toHaveBeenCalledOnce();
      },
      dispose: async () => {},
    },
  });
  expect(recorder.recordEvent).not.toHaveBeenCalled();
  await owner.complete();
  expect(recorder.recordEvent).toHaveBeenCalledWith("session.ended", expect.any(Object));
});

it("preserves a teardown failure raised outside the caller async context", async () => {
  const tracker = createEmbeddedAttemptSessionSettleTracker({
    abort: () => Promise.reject(new Error("native abort failed")),
  });
  await expect(tracker.abortActiveSession()).rejects.toThrow("native abort failed");
  const cleanupScope = createAgentCleanupScope();
  await cleanupScope.run(async () => tracker.buildAbortSettlePromise());
  expect(cleanupScope.outcome).toBe("uncertain");
});
it.each([false, true])(
  "waits for prompt and abort settlement (rejected prompt=%s)",
  async (rejectPrompt) => {
    const prompt = deferred();
    const abort = deferred();
    const abortSession = vi.fn(() => abort.promise);
    const tracker = createEmbeddedAttemptSessionSettleTracker({ abort: abortSession });

    void tracker.trackPromptSettlePromise(prompt.promise);
    const abortReason = new Error("stop");
    void tracker.abortActiveSession(abortReason);
    const settled = tracker.buildAbortSettlePromise();
    expect(abortSession).toHaveBeenCalledWith(abortReason);

    const finished = vi.fn();
    void settled?.then(finished);
    if (rejectPrompt) {
      prompt.reject(new Error("prompt failed"));
    } else {
      prompt.resolve();
    }
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();

    abort.resolve();
    await settled;
    expect(finished).toHaveBeenCalledOnce();
    expect(tracker.buildAbortSettlePromise()).toBeNull();
  },
);
