import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_INJECTED_STEER_MESSAGE_CHARS } from "../../shared/steer-message-injection-policy.js";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  consumeEmbeddedRunModelSwitch,
  getActiveEmbeddedRunSnapshot,
  queueEmbeddedPiMessage,
  requestEmbeddedRunModelSwitch,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
  waitForActiveEmbeddedRuns,
} from "./runs.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: {
    isCompacting?: boolean;
    isStreaming?: boolean;
    isStopped?: () => boolean;
    queueMessage?: (text: string) => Promise<void>;
    abort?: () => void;
  } = {},
): RunHandle {
  const abort = overrides.abort ?? (() => {});
  const handle: RunHandle = {
    queueMessage: overrides.queueMessage ?? (async () => {}),
    isStreaming: () => overrides.isStreaming ?? true,
    isCompacting: () => overrides.isCompacting ?? false,
    abort,
  };
  if (overrides.isStopped) {
    handle.isStopped = overrides.isStopped;
  }
  return handle;
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

  it("queues into active non-streaming handles that expose stopped state", () => {
    const queueMessage = vi.fn(async () => {});

    setActiveEmbeddedRun(
      "session-active",
      createRunHandle({
        isStreaming: false,
        isStopped: () => false,
        queueMessage,
      }),
    );

    expect(queueEmbeddedPiMessage("session-active", "keep going")).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("keep going");
  });

  it("rejects oversized messages for active runs", () => {
    const queueMessage = vi.fn(async () => {});

    setActiveEmbeddedRun(
      "session-too-large",
      createRunHandle({
        queueMessage,
      }),
    );

    expect(
      queueEmbeddedPiMessage("session-too-large", "x".repeat(MAX_INJECTED_STEER_MESSAGE_CHARS + 1)),
    ).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("keeps the streaming fallback for handles without stopped state", () => {
    const queueMessage = vi.fn(async () => {});

    setActiveEmbeddedRun(
      "session-compat",
      createRunHandle({
        isStreaming: false,
        queueMessage,
      }),
    );

    expect(queueEmbeddedPiMessage("session-compat", "keep going")).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("does not queue into stopped handles", () => {
    const queueMessage = vi.fn(async () => {});

    setActiveEmbeddedRun(
      "session-stopped",
      createRunHandle({
        isStreaming: true,
        isStopped: () => true,
        queueMessage,
      }),
    );

    expect(queueEmbeddedPiMessage("session-stopped", "keep going")).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("fails closed when stopped state checks throw", () => {
    const queueMessage = vi.fn(async () => {});

    setActiveEmbeddedRun(
      "session-bad-state",
      createRunHandle({
        isStopped: () => {
          throw new Error("bad stopped state");
        },
        queueMessage,
      }),
    );

    expect(queueEmbeddedPiMessage("session-bad-state", "keep going")).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
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
