import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  consumeEmbeddedRunModelSwitch,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedPiRunActive,
  moveActiveEmbeddedRun,
  requestEmbeddedRunModelSwitch,
  resolveActiveEmbeddedRunSessionId,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
  waitForActiveEmbeddedRuns,
  waitForEmbeddedPiRunEnd,
} from "./runs.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: { isCompacting?: boolean; abort?: () => void } = {},
): RunHandle {
  const abort = overrides.abort ?? (() => {});
  return {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => overrides.isCompacting ?? false,
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

  it("moves active run state to a rotated session id without ending the run", async () => {
    vi.useFakeTimers();
    try {
      const handle = createRunHandle();
      setActiveEmbeddedRun("session-old", handle, "main");
      updateActiveEmbeddedRunSnapshot("session-old", {
        transcriptLeafId: "leaf-1",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
        inFlightPrompt: "hello",
      });
      requestEmbeddedRunModelSwitch("session-old", {
        provider: "openai",
        model: "gpt-5.4",
      });

      const oldWaitPromise = waitForEmbeddedPiRunEnd("session-old", 1_000);

      expect(
        moveActiveEmbeddedRun({
          fromSessionId: "session-old",
          toSessionId: "session-new",
          handle,
          fromSessionKey: "main",
          toSessionKey: "main",
        }),
      ).toBe(true);

      expect(isEmbeddedPiRunActive("session-old")).toBe(false);
      expect(isEmbeddedPiRunActive("session-new")).toBe(true);
      expect(resolveActiveEmbeddedRunSessionId("main")).toBe("session-new");
      expect(getActiveEmbeddedRunSnapshot("session-old")).toBeUndefined();
      expect(getActiveEmbeddedRunSnapshot("session-new")).toEqual({
        transcriptLeafId: "leaf-1",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
        inFlightPrompt: "hello",
      });
      expect(consumeEmbeddedRunModelSwitch("session-old")).toBeUndefined();
      expect(consumeEmbeddedRunModelSwitch("session-new")).toEqual({
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: undefined,
        authProfileIdSource: undefined,
      });

      let oldWaitResolved = false;
      void oldWaitPromise.then(() => {
        oldWaitResolved = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(oldWaitResolved).toBe(false);

      clearActiveEmbeddedRun("session-new", handle, "main");

      await expect(oldWaitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("does not overwrite another active run when a rotated session id is already occupied", () => {
    const oldHandle = createRunHandle();
    const occupiedHandle = createRunHandle();

    setActiveEmbeddedRun("session-old", oldHandle, "main");
    setActiveEmbeddedRun("session-new", occupiedHandle, "other");

    expect(
      moveActiveEmbeddedRun({
        fromSessionId: "session-old",
        toSessionId: "session-new",
        handle: oldHandle,
        fromSessionKey: "main",
        toSessionKey: "main",
      }),
    ).toBe(false);

    expect(isEmbeddedPiRunActive("session-old")).toBe(true);
    expect(isEmbeddedPiRunActive("session-new")).toBe(true);
    expect(resolveActiveEmbeddedRunSessionId("main")).toBe("session-old");
    expect(resolveActiveEmbeddedRunSessionId("other")).toBe("session-new");
  });
});
