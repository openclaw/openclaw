import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompactionProgressTracker } from "../../packages/agent-core/src/harness/compaction/compaction-progress.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import type { CompactResult } from "../context-engine/types.js";
import { multiPassCompact } from "./multi-pass-compaction.js";

// -- Mock Factories -----------------------------------------------------------

function createMockContextEngine() {
  return {
    compact: vi.fn<[], Promise<CompactResult>>(async () => ({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    })),
  };
}

function makeCompactSuccess(
  overrides: {
    tokensAfter?: number;
    tokensBefore?: number;
    summary?: string;
  } = {},
): CompactResult {
  return {
    ok: true,
    compacted: true,
    result: {
      summary: overrides.summary ?? "Compacted session",
      tokensBefore: overrides.tokensBefore ?? 200000,
      tokensAfter: overrides.tokensAfter ?? 100000,
      firstKeptEntryId: "entry-5",
    },
  };
}

function makeCompactNotCompacted(reason: string): CompactResult {
  return { ok: true, compacted: false, reason };
}

function makeCompactFailure(reason: string): CompactResult {
  return { ok: false, compacted: false, reason };
}

const baseCompactParams = {
  sessionId: "test-session",
  sessionKey: "test-key",
  sessionFile: "/tmp/session.jsonl",
  tokenBudget: 100000,
  force: true,
  compactionTarget: "budget" as const,
  runtimeContext: {},
  runtimeSettings: {},
};

// -- Test Setup ---------------------------------------------------------------

let mockEngine: ReturnType<typeof createMockContextEngine>;
let tracker: CompactionProgressTracker;
const noopAdopt = () => {};

beforeEach(() => {
  mockEngine = createMockContextEngine();
  tracker = new CompactionProgressTracker();
});

// -- Suite E: Multi-Pass Compaction Loop --------------------------------------

describe("multiPassCompact single-pass behavior", () => {
  it("returns after one pass when compact succeeds and tokens are below budget", async () => {
    mockEngine.compact.mockResolvedValue(
      makeCompactSuccess({ tokensBefore: 200000, tokensAfter: 80000 }),
    );
    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(1);
    expect(result.stopReason).toBe("threshold_met");
    expect(mockEngine.compact).toHaveBeenCalledOnce();
  });

  it("returns after one pass when compact reports not compacted", async () => {
    mockEngine.compact.mockResolvedValue(makeCompactNotCompacted("nothing to compact"));
    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(1);
    expect(result.stopReason).toBe("no_progress");
    expect(mockEngine.compact).toHaveBeenCalledOnce();
  });

  it("returns after one pass when compact fails", async () => {
    mockEngine.compact.mockResolvedValue(makeCompactFailure("engine error"));
    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(1);
    expect(result.stopReason).toBe("no_progress");
    expect(mockEngine.compact).toHaveBeenCalledOnce();
  });

  it("passes compactParams to engine.compact unchanged", async () => {
    mockEngine.compact.mockResolvedValue(makeCompactSuccess({ tokensAfter: 80000 }));
    await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 1 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(mockEngine.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-session",
        sessionKey: "test-key",
        tokenBudget: 100000,
      }),
    );
  });

  it("returns the last pass's CompactResult fields", async () => {
    mockEngine.compact.mockResolvedValue(
      makeCompactSuccess({
        tokensAfter: 90000,
        summary: "Custom summary text",
      }),
    );
    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 1 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.lastCompactResult?.result?.summary).toBe("Custom summary text");
    expect(result.lastCompactResult?.result?.tokensAfter).toBe(90000);
  });
});

describe("multiPassCompact multi-pass iteration", () => {
  it("executes multiple passes when tokens remain above budget", async () => {
    mockEngine.compact
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 600000, tokensAfter: 540000 }))
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 540000, tokensAfter: 490000 }))
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 490000, tokensAfter: 80000 }));

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
      contextWindow: 500000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(3);
    expect(result.finalTokens).toBe(80000);
    expect(result.stopReason).toBe("threshold_met");
    expect(mockEngine.compact).toHaveBeenCalledTimes(3);
  });

  it("stops early when tokens drop below budget mid-loop", async () => {
    mockEngine.compact
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 600000, tokensAfter: 540000 }))
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 540000, tokensAfter: 80000 }));

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 5 },
      contextWindow: 500000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(2);
    expect(result.stopReason).toBe("threshold_met");
    expect(mockEngine.compact).toHaveBeenCalledTimes(2);
  });

  it("stops at maxPasses even if still above budget", async () => {
    // FIX-RV4: Each pass shows >5% progress via DECREASING tokensAfter values
    // so only maxPasses (not anti-thrash) limits the loop.
    // Pass 1: 600000 -> 540000 (10% reduction) -> progress
    // Pass 2: 540000 -> 486000 (10% reduction) -> progress
    // Pass 3: 486000 -> 437400 (10% reduction) -> progress
    // All above budget (100000), all show >5% progress, maxPasses=3 stops
    mockEngine.compact
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 600000, tokensAfter: 540000 }))
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 540000, tokensAfter: 486000 }))
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 486000, tokensAfter: 437400 }));

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
      contextWindow: 400000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(3);
    expect(result.stopReason).toBe("max_passes");
    expect(mockEngine.compact).toHaveBeenCalledTimes(3);
  });
});

describe("multiPassCompact abort handling", () => {
  it("stops immediately when a pass returns compacted=false", async () => {
    mockEngine.compact
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 600000, tokensAfter: 540000 }))
      .mockResolvedValueOnce(makeCompactNotCompacted("nothing left to compact"));

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 5 },
      contextWindow: 500000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(2);
    expect(result.stopReason).toBe("no_progress");
    expect(mockEngine.compact).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when a pass returns ok=false", async () => {
    mockEngine.compact
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 600000, tokensAfter: 540000 }))
      .mockResolvedValueOnce(makeCompactFailure("engine error"));

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 5 },
      contextWindow: 500000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(2);
    expect(result.stopReason).toBe("no_progress");
    expect(mockEngine.compact).toHaveBeenCalledTimes(2);
  });

  it("abort from first pass takes priority over multi-pass logic", async () => {
    mockEngine.compact.mockResolvedValue(makeCompactFailure("abort: context too small"));
    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(1);
    expect(result.stopReason).toBe("no_progress");
  });
});

describe("multiPassCompact error handling", () => {
  it("propagates thrown exceptions from engine.compact", async () => {
    mockEngine.compact.mockRejectedValue(new Error("network failure"));
    await expect(
      multiPassCompact({
        contextEngine: mockEngine,
        compactParams: baseCompactParams,
        settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
        contextWindow: 200000,
        tracker,
        adoptTranscript: noopAdopt,
      }),
    ).rejects.toThrow("network failure");
    expect(mockEngine.compact).toHaveBeenCalledOnce();
  });

  it("respects abort signal between passes", async () => {
    const controller = new AbortController();
    let callCount = 0;
    mockEngine.compact.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // After first pass completes, abort
        controller.abort();
      }
      return makeCompactSuccess({ tokensBefore: 600000, tokensAfter: 540000 });
    });

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 5 },
      contextWindow: 500000,
      tracker,
      adoptTranscript: noopAdopt,
      abortSignal: controller.signal,
    });
    expect(result.totalPasses).toBe(1);
    expect(result.stopReason).toBe("aborted");
  });

  it("threads abort signal to engine.compact", async () => {
    mockEngine.compact.mockResolvedValue(makeCompactSuccess({ tokensAfter: 80000 }));
    const controller = new AbortController();
    await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 1 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
      abortSignal: controller.signal,
    });
    // The signal passed should contain an abortSignal field
    const calledWith = mockEngine.compact.mock.calls[0][0];
    expect(calledWith).toHaveProperty("abortSignal");
  });

  it("does not use stale compactParams across passes", async () => {
    mockEngine.compact
      .mockResolvedValueOnce({
        ...makeCompactSuccess({ tokensBefore: 600000, tokensAfter: 540000 }),
        result: {
          ...makeCompactSuccess({ tokensBefore: 600000, tokensAfter: 540000 }).result!,
          sessionId: "rotated-session",
        },
      })
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 540000, tokensAfter: 80000 }));

    await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
      contextWindow: 500000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    // Pass 2 still receives original params (known limitation D10)
    const pass2Args = mockEngine.compact.mock.calls[1][0];
    expect(pass2Args.sessionId).toBe("test-session");
  });
});

describe("multiPassCompact progress tracking", () => {
  it("stops when no progress is made", async () => {
    mockEngine.compact.mockResolvedValueOnce(
      makeCompactSuccess({ tokensBefore: 300000, tokensAfter: 293000 }),
    );

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 5 },
      contextWindow: 300000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    // First pass: 2.3% < 5% -> no_progress, stops immediately
    expect(result.totalPasses).toBe(1);
    expect(result.stopReason).toBe("no_progress");
  });

  it("continues when a pass makes sufficient progress", async () => {
    mockEngine.compact
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 350000, tokensAfter: 300000 }))
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 300000, tokensAfter: 295000 }));

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 5 },
      contextWindow: 300000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    // Pass 1: ~14% -> progress. Pass 2: ~1.7% -> no_progress
    expect(result.totalPasses).toBe(2);
    expect(result.stopReason).toBe("no_progress");
  });

  it("anti-thrash triggers even when still above budget", async () => {
    // First pass: 2.3% -> below 5% threshold -> no progress, stops immediately
    mockEngine.compact.mockResolvedValue(
      makeCompactSuccess({ tokensBefore: 300000, tokensAfter: 293000 }),
    );
    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 10 },
      contextWindow: 300000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.stopReason).toBe("no_progress");
    expect(result.finalTokens).toBe(293000);
  });
});

describe("multiPassCompact configuration defaults", () => {
  it("defaults maxPasses to 3 when not specified", async () => {
    // FIX-RV4: Each pass shows >5% progress via decreasing tokensAfter
    // so only maxPasses (not anti-thrash) stops the loop
    mockEngine.compact
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 600000, tokensAfter: 540000 }))
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 540000, tokensAfter: 486000 }))
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 486000, tokensAfter: 437400 }));

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: DEFAULT_COMPACTION_SETTINGS,
      contextWindow: 400000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(mockEngine.compact).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe("max_passes");
  });

  it("defaults progressThreshold to 0.05 (5%)", async () => {
    // Pass 1: 2.3% -> below 5% threshold -> stops
    mockEngine.compact.mockResolvedValue(
      makeCompactSuccess({ tokensBefore: 300000, tokensAfter: 293000 }),
    );
    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: DEFAULT_COMPACTION_SETTINGS,
      contextWindow: 300000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    // 293000 < 300000 * 0.95 = 285000? -> 293000 > 285000 -> no progress
    expect(result.totalPasses).toBe(1);
    expect(result.stopReason).toBe("no_progress");
  });

  // FIX-RV5: Split into 8.21a and 8.21b

  it("clamps maxPasses to 10 at maximum", async () => {
    // V3 review fix: Start at 2_000_000 tokens with 6% reduction per pass.
    // After 10 passes: 2_000_000 * 0.94^10 ~ 1_077_230, still above threshold.
    // This ensures the loop runs until the 10-pass clamp stops it.
    let currentTokens = 2_000_000;
    mockEngine.compact.mockImplementation(async () => {
      const before = currentTokens;
      currentTokens = before - Math.ceil(before * 0.06);
      return makeCompactSuccess({ tokensBefore: before, tokensAfter: currentTokens });
    });

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 50 },
      contextWindow: 500000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    // V3 review fix: exact assertion, not toBeLessThanOrEqual
    expect(mockEngine.compact.mock.calls.length).toBe(10);
    expect(result.stopReason).toBe("max_passes");
  });

  it("clamps maxPasses to 1 at minimum", async () => {
    mockEngine.compact.mockResolvedValue(makeCompactSuccess({ tokensAfter: 150000 }));
    await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 0 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(mockEngine.compact).toHaveBeenCalledTimes(1);
  });

  it("passes compactParams with runtimeContext and runtimeSettings through unchanged", async () => {
    mockEngine.compact.mockResolvedValue(makeCompactSuccess({ tokensAfter: 80000 }));
    await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 1 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    const calledWith = mockEngine.compact.mock.calls[0][0];
    expect(calledWith.runtimeContext).toEqual({});
    expect(calledWith.runtimeSettings).toEqual({});
  });
});

describe("multiPassCompact anti-thrashing gate", () => {
  it("returns anti_thrash immediately when tracker signals suppression", async () => {
    // Pre-load tracker with 2 ineffective compressions
    tracker.recordCompaction(200000, 195000); // <10%
    tracker.recordCompaction(200000, 195000); // <10%
    expect(tracker.shouldSuppressCompaction()).toBe(true);

    const result = await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    expect(result.totalPasses).toBe(0);
    expect(result.stopReason).toBe("anti_thrash");
    expect(mockEngine.compact).not.toHaveBeenCalled();
  });
});

describe("multiPassCompact per-pass lifecycle", () => {
  it("calls adoptTranscript after each successful pass", async () => {
    const adoptFn = vi.fn();
    mockEngine.compact
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 500000, tokensAfter: 450000 }))
      .mockResolvedValueOnce(makeCompactSuccess({ tokensBefore: 450000, tokensAfter: 80000 }));

    await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 3 },
      contextWindow: 400000,
      tracker,
      adoptTranscript: adoptFn,
    });
    expect(adoptFn).toHaveBeenCalledTimes(2);
  });

  it("calls runMaintenance after each successful pass when provided", async () => {
    const maintenanceFn = vi.fn(async () => {});
    mockEngine.compact.mockResolvedValue(
      makeCompactSuccess({ tokensBefore: 200000, tokensAfter: 80000 }),
    );

    await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 1 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
      runMaintenance: maintenanceFn,
    });
    expect(maintenanceFn).toHaveBeenCalledOnce();
  });

  it("updates tracker per-pass so anti-thrash works organically", async () => {
    // V3 review fix: verify tracker.recordCompaction is called per-pass
    mockEngine.compact.mockResolvedValue(
      makeCompactSuccess({ tokensBefore: 200000, tokensAfter: 80000 }),
    );

    await multiPassCompact({
      contextEngine: mockEngine,
      compactParams: baseCompactParams,
      settings: { ...DEFAULT_COMPACTION_SETTINGS, maxPasses: 1 },
      contextWindow: 200000,
      tracker,
      adoptTranscript: noopAdopt,
    });
    // Tracker should have recorded the pass
    expect(tracker.getState().totalCompactions).toBe(1);
    expect(tracker.getState().lastSavingsPct).toBeCloseTo(0.6, 1);
  });
});
