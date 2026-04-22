import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  consumeEmbeddedRunModelSwitch,
  forceDetachEmbeddedRun,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunActiveForSessionKey,
  queueEmbeddedPiMessage,
  requestEmbeddedRunModelSwitch,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
  waitForActiveEmbeddedRuns,
  waitForEmbeddedPiRunEnd,
} from "./runs.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: { isCompacting?: boolean; isStopped?: boolean; abort?: () => void } = {},
): RunHandle {
  const abort = overrides.abort ?? (() => {});
  return {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => overrides.isCompacting ?? false,
    isStopped: () => overrides.isStopped ?? false,
    abort,
  };
}

describe("pi-embedded runner run registry", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("aborts only compacting runs in compacting mode", () => {
    const abortCompacting = vi.fn();
    const abortNormal = vi.fn();

    setActiveEmbeddedRun(
      "session-compacting",
      createRunHandle({ isCompacting: true, abort: abortCompacting }),
    );

    setActiveEmbeddedRun("session-normal", createRunHandle({ abort: abortNormal }));

    const aborted = abortEmbeddedPiRun(undefined, { mode: "compacting" });
    expect(aborted).toBe(true);
    expect(abortCompacting).toHaveBeenCalledTimes(1);
    expect(abortNormal).not.toHaveBeenCalled();
  });

  it("aborts every active run in all mode", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun("session-a", createRunHandle({ isCompacting: true, abort: abortA }));

    setActiveEmbeddedRun("session-b", createRunHandle({ abort: abortB }));

    const aborted = abortEmbeddedPiRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("waits for active runs to drain", async () => {
    vi.useFakeTimers();
    try {
      const handle = createRunHandle();
      setActiveEmbeddedRun("session-a", handle);
      setTimeout(() => {
        clearActiveEmbeddedRun("session-a", handle);
      }, 500);

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await waitPromise;

      expect(result.drained).toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("returns drained=false when timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      setActiveEmbeddedRun("session-a", createRunHandle());

      const waitPromise = waitForActiveEmbeddedRuns(1_000, { pollMs: 100 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await waitPromise;
      expect(result.drained).toBe(false);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("shares active run state across distinct module instances", async () => {
    const runsA = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-a",
    );
    const runsB = await importFreshModule<typeof import("./runs.js")>(
      import.meta.url,
      "./runs.js?scope=shared-b",
    );
    const handle = createRunHandle();

    runsA.__testing.resetActiveEmbeddedRuns();
    runsB.__testing.resetActiveEmbeddedRuns();

    try {
      runsA.setActiveEmbeddedRun("session-shared", handle);
      expect(runsB.isEmbeddedPiRunActive("session-shared")).toBe(true);

      runsB.clearActiveEmbeddedRun("session-shared", handle);
      expect(runsA.isEmbeddedPiRunActive("session-shared")).toBe(false);
    } finally {
      runsA.__testing.resetActiveEmbeddedRuns();
      runsB.__testing.resetActiveEmbeddedRuns();
    }
  });

  it("tracks and clears per-session transcript snapshots for active runs", () => {
    const handle = createRunHandle();

    setActiveEmbeddedRun("session-snapshot", handle);
    updateActiveEmbeddedRunSnapshot("session-snapshot", {
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toEqual({
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });

    clearActiveEmbeddedRun("session-snapshot", handle);
    expect(getActiveEmbeddedRunSnapshot("session-snapshot")).toBeUndefined();
  });

  it("stores and consumes pending live model switch requests", () => {
    expect(
      requestEmbeddedRunModelSwitch("session-switch", {
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toBe(true);

    expect(consumeEmbeddedRunModelSwitch("session-switch")).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(consumeEmbeddedRunModelSwitch("session-switch")).toBeUndefined();
  });

  it("drops pending live model switch requests when the run clears", () => {
    const handle = createRunHandle();
    setActiveEmbeddedRun("session-clear-switch", handle);
    requestEmbeddedRunModelSwitch("session-clear-switch", {
      provider: "openai",
      model: "gpt-5.4",
    });

    clearActiveEmbeddedRun("session-clear-switch", handle);

    expect(consumeEmbeddedRunModelSwitch("session-clear-switch")).toBeUndefined();
  });
});

describe("queueEmbeddedPiMessage", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
  });

  function createQueueableHandle(
    overrides: { isCompacting?: boolean; isStreaming?: boolean; isStopped?: boolean } = {},
  ): RunHandle & { queueMessageSpy: ReturnType<typeof vi.fn> } {
    const queueMessageSpy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    return {
      queueMessage: queueMessageSpy,
      isStreaming: () => overrides.isStreaming ?? true,
      isCompacting: () => overrides.isCompacting ?? false,
      isStopped: () => overrides.isStopped ?? false,
      abort: () => {},
      queueMessageSpy,
    };
  }

  it("returns false when no active run exists for the session", () => {
    const result = queueEmbeddedPiMessage("no-such-session", "hello");
    expect(result).toBe(false);
  });

  it("queues message when session is active but NOT streaming (original bug case)", () => {
    const handle = createQueueableHandle({ isStreaming: false });
    setActiveEmbeddedRun("session-not-streaming", handle);

    const result = queueEmbeddedPiMessage("session-not-streaming", "steer message");

    expect(result).toBe(true);
    expect(handle.queueMessageSpy).toHaveBeenCalledWith("steer message");
  });

  it("returns false when session is active but compacting", () => {
    const handle = createQueueableHandle({ isCompacting: true });
    setActiveEmbeddedRun("session-compacting", handle);

    const result = queueEmbeddedPiMessage("session-compacting", "steer message");

    expect(result).toBe(false);
    expect(handle.queueMessageSpy).not.toHaveBeenCalled();
  });

  it("queues message when session is active and streaming (not compacting)", () => {
    const handle = createQueueableHandle();
    setActiveEmbeddedRun("session-streaming", handle);

    const result = queueEmbeddedPiMessage("session-streaming", "steer message");

    expect(result).toBe(true);
    expect(handle.queueMessageSpy).toHaveBeenCalledWith("steer message");
  });

  it("returns false when agent loop is not yet running or already stopped", () => {
    const handle = createQueueableHandle({ isStopped: true });
    setActiveEmbeddedRun("session-stopped", handle);

    const result = queueEmbeddedPiMessage("session-stopped", "steer message");

    expect(result).toBe(false);
    expect(handle.queueMessageSpy).not.toHaveBeenCalled();
  });

  it("queues message when session is active, not streaming, and not stopped (tool execution)", () => {
    const handle = createQueueableHandle({ isStreaming: false, isStopped: false });
    setActiveEmbeddedRun("session-tool-exec", handle);

    const result = queueEmbeddedPiMessage("session-tool-exec", "steer message");

    expect(result).toBe(true);
    expect(handle.queueMessageSpy).toHaveBeenCalledWith("steer message");
  });
});

describe("isEmbeddedPiRunActiveForSessionKey", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
  });

  it("returns true when a run is active for the resolved session key", () => {
    const handle = createRunHandle();
    setActiveEmbeddedRun("session-abc", handle, "key-abc");
    expect(isEmbeddedPiRunActiveForSessionKey("key-abc")).toBe(true);
  });

  it("returns false when no run is active for the session key", () => {
    expect(isEmbeddedPiRunActiveForSessionKey("key-nonexistent")).toBe(false);
  });

  it("returns false after the run is cleared", () => {
    const handle = createRunHandle();
    setActiveEmbeddedRun("session-cleared", handle, "key-cleared");
    clearActiveEmbeddedRun("session-cleared", handle, "key-cleared");
    expect(isEmbeddedPiRunActiveForSessionKey("key-cleared")).toBe(false);
  });
});

describe("forceDetachEmbeddedRun", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
  });

  it("removes the run from the registry without notifying global waiters", async () => {
    const handle = createRunHandle();
    setActiveEmbeddedRun("session-detach", handle, "key-detach");

    // A concurrent waiter (e.g. session-reset) should NOT be resolved by
    // forceDetach — the detached run is still executing in the background.
    const waitPromise = waitForEmbeddedPiRunEnd("session-detach", 500);

    const detached = forceDetachEmbeddedRun("session-detach");
    expect(detached).toBe(true);

    // Registry is cleared
    expect(isEmbeddedPiRunActive("session-detach")).toBe(false);
    expect(isEmbeddedPiRunActiveForSessionKey("key-detach")).toBe(false);

    // Waiter resolves with false (force-detach cleans up waiters with
    // conservative "not cleanly ended" signal). session-reset should see
    // the run as still active since the detached run is still executing.
    const ended = await waitPromise;
    expect(ended).toBe(false);
  });

  it("returns false when no run is registered", () => {
    expect(forceDetachEmbeddedRun("nonexistent")).toBe(false);
  });

  it("old run's clearActiveEmbeddedRun becomes no-op after force-detach", () => {
    const handle = createRunHandle();
    setActiveEmbeddedRun("session-overlap", handle, "key-overlap");

    forceDetachEmbeddedRun("session-overlap");

    // Register a new run for the same session
    const newHandle = createRunHandle();
    setActiveEmbeddedRun("session-overlap", newHandle, "key-overlap");

    // Old run's finally block calls clearActiveEmbeddedRun with old handle
    clearActiveEmbeddedRun("session-overlap", handle, "key-overlap");

    // New run should still be active (handle mismatch → no-op)
    expect(isEmbeddedPiRunActive("session-overlap")).toBe(true);
  });
});
