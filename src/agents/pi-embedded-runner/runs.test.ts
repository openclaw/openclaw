import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  forceClearActiveEmbeddedRun,
  getActiveEmbeddedRunSnapshot,
  isEmbeddedPiRunActive,
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

  it("force-clears an active run regardless of handle identity", () => {
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };

    setActiveEmbeddedRun("session-force", handle);
    expect(isEmbeddedPiRunActive("session-force")).toBe(true);

    // Force-clear does not require the original handle
    forceClearActiveEmbeddedRun("session-force");
    expect(isEmbeddedPiRunActive("session-force")).toBe(false);
  });

  it("force-clear on idle session is a no-op", () => {
    // Should not throw or have side-effects when session is not active
    expect(isEmbeddedPiRunActive("session-idle")).toBe(false);
    forceClearActiveEmbeddedRun("session-idle");
    expect(isEmbeddedPiRunActive("session-idle")).toBe(false);
  });

  it("clearActiveEmbeddedRun with old handle is a no-op after force-clear", () => {
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };

    setActiveEmbeddedRun("session-double", handle);
    expect(isEmbeddedPiRunActive("session-double")).toBe(true);

    // Force-clear removes the run
    forceClearActiveEmbeddedRun("session-double");
    expect(isEmbeddedPiRunActive("session-double")).toBe(false);

    // Subsequent clearActiveEmbeddedRun with the old handle should be a no-op
    // (no error, no double-notify)
    clearActiveEmbeddedRun("session-double", handle);
    expect(isEmbeddedPiRunActive("session-double")).toBe(false);
  });

  it("force-clear also clears transcript snapshots", () => {
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };

    setActiveEmbeddedRun("session-snap-force", handle);
    updateActiveEmbeddedRunSnapshot("session-snap-force", {
      transcriptLeafId: "assistant-1",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      inFlightPrompt: "keep going",
    });
    expect(getActiveEmbeddedRunSnapshot("session-snap-force")).toBeDefined();

    forceClearActiveEmbeddedRun("session-snap-force");
    expect(getActiveEmbeddedRunSnapshot("session-snap-force")).toBeUndefined();
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
});
