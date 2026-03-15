import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  getActiveEmbeddedRunSnapshot,
  setActiveEmbeddedRun,
  updateActiveEmbeddedRunSnapshot,
  waitForActiveEmbeddedRuns,
} from "./runs.js";

describe("pi-embedded runner run registry", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("aborts only compacting runs in compacting mode", () => {
    const abortCompacting = vi.fn();
    const abortNormal = vi.fn();

    setActiveEmbeddedRun("session-compacting", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => true,
      abort: abortCompacting,
    });

    setActiveEmbeddedRun("session-normal", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortNormal,
    });

    const aborted = abortEmbeddedPiRun(undefined, { mode: "compacting" });
    expect(aborted).toBe(true);
    expect(abortCompacting).toHaveBeenCalledTimes(1);
    expect(abortNormal).not.toHaveBeenCalled();
  });

  it("aborts every active run in all mode", () => {
    const abortA = vi.fn();
    const abortB = vi.fn();

    setActiveEmbeddedRun("session-a", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => true,
      abort: abortA,
    });

    setActiveEmbeddedRun("session-b", {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: abortB,
    });

    const aborted = abortEmbeddedPiRun(undefined, { mode: "all" });
    expect(aborted).toBe(true);
    expect(abortA).toHaveBeenCalledTimes(1);
    expect(abortB).toHaveBeenCalledTimes(1);
  });

  it("waits for active runs to drain", async () => {
    vi.useFakeTimers();
    try {
      const handle = {
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      };
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
      setActiveEmbeddedRun("session-a", {
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: vi.fn(),
      });

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
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };

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
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };

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
  it("clears stale snapshots when replacing an active run for the same session", () => {
    const firstHandle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    const secondHandle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };

    setActiveEmbeddedRun("session-replaced", firstHandle);
    updateActiveEmbeddedRunSnapshot("session-replaced", {
      transcriptLeafId: "assistant-old",
      messages: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
      inFlightPrompt: "old prompt",
    });

    setActiveEmbeddedRun("session-replaced", secondHandle);

    expect(getActiveEmbeddedRunSnapshot("session-replaced")).toBeUndefined();
  });
});
