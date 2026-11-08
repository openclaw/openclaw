import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { readGlobalSingleton } from "../../../shared/global-singleton.js";
import { expectCollected, expectLiveObjects } from "../../../test-utils/retention.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  clearEmbeddedSessionPromptStates,
  retainEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import {
  cleanupEmbeddedAttemptSessionPhase,
  createEmbeddedAttemptSessionResources,
  createEmbeddedAttemptSessionSettleTracker,
} from "./attempt-session-settle.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import { createEmbeddedAttemptDeferredLifecycleOwner } from "./deferred-lifecycle-owner.js";

registerAgentSessionLoopTestLifecycle();

it.each([
  { outcome: "stop", releaseFails: false },
  { outcome: "error", releaseFails: false },
  { outcome: "aborted", releaseFails: false },
  { outcome: "stop", releaseFails: true },
  { outcome: "aborted", releaseFails: true },
] as const)(
  "releases transcript listeners after $outcome (actor release fails=$releaseFails)",
  async ({ outcome, releaseFails }) => {
    const listeners = readGlobalSingleton(
      Symbol.for("openclaw.internalSessionTranscriptListeners"),
    );
    expect(listeners).toBeInstanceOf(Set);
    if (!(listeners instanceof Set)) {
      throw new Error("Transcript listener registry is unavailable");
    }
    const baseline = listeners.size;
    const releaseError = new Error("transcript actor release failed");
    const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
      onDrained: () => {
        if (releaseFails) {
          throw releaseError;
        }
      },
    });
    const { session, sessionManager } = await createTestSession({
      withSessionWriteSettlement: (operation) => lifecycle.withTranscriptWrite(operation),
    });
    expect(listeners.size).toBe(baseline + 1);
    const entered = deferred();
    streamMocks.streamSimple.mockImplementation((model, _context, options) => {
      const message = createAssistant(model, outcome === "stop" ? "Done" : "", outcome);
      if (outcome !== "aborted") {
        return createAssistantResultStream(message);
      }
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener(
        "abort",
        () => {
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end();
        },
        { once: true },
      );
      entered.resolve();
      return stream;
    });
    const prompt = session.prompt("Synthetic lifecycle probe");
    if (outcome === "aborted") {
      await entered.promise;
      await session.abort();
    }
    await prompt;
    expect(session.isStreaming).toBe(false);
    if (outcome !== "aborted") {
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: outcome });
    }
    const terminal =
      outcome === "aborted"
        ? ({ kind: "aborted", source: "external" } as const)
        : outcome === "error"
          ? ({ kind: "failed", source: "prompt", error: new Error("provider failed") } as const)
          : ({ kind: "ok" } as const);
    const cleanup = cleanupEmbeddedAttemptSessionPhase({
      attempt: { sessionId: sessionManager.getSessionId(), runId: "listener-lifecycle" },
      session,
      sessionManager,
      trajectoryRecorder: null,
      trajectoryEndRecorded: false,
      buildAbortSettlePromise: () => null,
      state: { terminal, beforeAgentRunBlockedBy: undefined },
      transcriptLifecycle: lifecycle,
    });
    if (releaseFails) {
      await expect(cleanup).rejects.toBe(releaseError);
    } else {
      await cleanup;
    }
    expect(listeners.size).toBe(baseline);
  },
);

it("releases prompt payloads while completed attempts' resource owners remain reachable", async () => {
  class PromptPayload extends Set<string> {}
  const payloads: WeakRef<PromptPayload>[] = [];
  let sequence = 0;
  const createRetainedReview = (release: boolean) => {
    const owner = createEmbeddedAttemptSessionResources(new AbortController().signal);
    const lease = retainEmbeddedSessionPromptState(`retained-review-${sequence++}`);
    lease.state.removedRuntimeContextKeys = new PromptPayload(["runtime-context"]);
    payloads.push(new WeakRef(lease.state.removedRuntimeContextKeys));
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
    await expectLiveObjects(payloads, 1);
    callbacks.shift();
    await expectCollected(...payloads);
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
