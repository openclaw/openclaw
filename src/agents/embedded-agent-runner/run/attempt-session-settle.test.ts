import { queryObjects } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import type { AgentSession } from "../../sessions/index.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
  retainEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import {
  cleanupEmbeddedAttemptSessionPhase,
  createEmbeddedAttemptSessionResources,
  createEmbeddedAttemptSessionSettleTracker,
} from "./attempt-session-settle.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("releases prompt payloads while completed attempts' review callbacks remain reachable", () => {
  class PromptPayload extends Set<string> {}
  let sequence = 0;
  const createRetainedReview = (release: boolean) => {
    const owner = createEmbeddedAttemptSessionResources(undefined, new AbortController().signal);
    const lease = retainEmbeddedSessionPromptState(`retained-review-${sequence++}`);
    lease.state.prunedImageMessages = new PromptPayload(["projected-image"]);
    owner.resources.promptStateLease = lease;
    if (release) {
      owner.releaseReview();
    }
    lease[Symbol.dispose]();
    return owner.reviewTranscript;
  };
  const callbacks = [createRetainedReview(false)];
  try {
    for (const count of [4, 32]) {
      callbacks.push(...Array.from({ length: count }, () => createRetainedReview(true)));
      expect(queryObjects(PromptPayload)).toBe(1);
    }
    callbacks.shift();
    expect(queryObjects(PromptPayload)).toBe(0);
    expect(callbacks.every((review) => review() === undefined)).toBe(true);
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
      sessionAgentId: "main",
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
      expect(getEmbeddedSessionPromptState(sessionId)).toBe(lease.state);
      finish.resolve();
      expect(await outcome).toEqual(fails ? new Error("cleanup failed") : undefined);
      expect(getEmbeddedSessionPromptState(sessionId)).not.toBe(lease.state);
    } finally {
      finish.resolve();
      await outcome;
      clearEmbeddedSessionPromptStates([sessionId]);
    }
  },
);

describe("createEmbeddedAttemptSessionSettleTracker", () => {
  it("preserves a teardown failure raised outside the caller async context", async () => {
    const tracker = createEmbeddedAttemptSessionSettleTracker({
      abort: async () => {
        throw new Error("native abort failed");
      },
    });
    await expect(tracker.abortActiveSession()).rejects.toThrow("native abort failed");
    const cleanupScope = createAgentCleanupScope();
    await cleanupScope.run(async () => {
      await tracker.buildAbortSettlePromise();
    });
    expect(cleanupScope.outcome).toBe("uncertain");
  });
  it("waits for both prompt and abort settlement during cleanup", async () => {
    const prompt = deferred();
    const abort = deferred();
    const abortSession = vi.fn(() => abort.promise);
    const tracker = createEmbeddedAttemptSessionSettleTracker({
      abort: abortSession,
    } as unknown as Pick<AgentSession, "abort">);

    void tracker.trackPromptSettlePromise(prompt.promise);
    const abortReason = new Error("stop");
    void tracker.abortActiveSession(abortReason);
    const settled = tracker.buildAbortSettlePromise();
    expect(settled).not.toBeNull();
    expect(abortSession).toHaveBeenCalledWith(abortReason);

    let finished = false;
    void settled?.then(() => {
      finished = true;
    });
    prompt.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);

    abort.resolve();
    await settled;
    expect(finished).toBe(true);
    expect(tracker.buildAbortSettlePromise()).toBeNull();
  });

  it("settles rejected prompt work without leaking it into later cleanup", async () => {
    const tracker = createEmbeddedAttemptSessionSettleTracker({
      abort: async () => undefined,
    } as unknown as Pick<AgentSession, "abort">);
    void tracker.trackPromptSettlePromise(Promise.reject(new Error("prompt failed")));

    await expect(tracker.buildAbortSettlePromise()).resolves.toBeUndefined();
    expect(tracker.buildAbortSettlePromise()).toBeNull();
  });
});
