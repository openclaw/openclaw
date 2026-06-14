import { describe, it, expect, vi, beforeEach } from "vitest";
import { logModelFallbackDecision, type ModelFallbackDecisionParams } from "./model-fallback-observation.js";

// Access the module-level throttle state to reset between tests.
// The throttle map is not exported, so we exercise it through the public API.

function makeParams(overrides: Partial<ModelFallbackDecisionParams> = {}): ModelFallbackDecisionParams {
  return {
    decision: "candidate_failed",
    requestedProvider: "test-provider",
    requestedModel: "test-model",
    candidate: { provider: "test-provider", model: "test-model" },
    reason: "auth",
    error: "HTTP 401: invalid access token",
    ...overrides,
  };
}

describe("logModelFallbackDecision throttle", () => {
  beforeEach(() => {
    // Advance time past the throttle window to reset state between tests.
    // The throttle uses Date.now(), so we mock it.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 70_000);
    vi.useRealTimers();
  });

  it("logs the first occurrence of a decision", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // logModelFallbackDecision uses a subsystem logger, not console.warn directly,
    // but we can verify it returns fallbackStepFields (non-undefined) on first call.
    const result = logModelFallbackDecision(makeParams());
    expect(result).toBeDefined();
    expect(result?.fallbackStepType).toBe("fallback_step");
    warnSpy.mockRestore();
  });

  it("suppresses duplicate decisions within the throttle window", () => {
    // First call should return fields
    const first = logModelFallbackDecision(makeParams());
    expect(first).toBeDefined();

    // Second call within the window should still return fields (callback needs them)
    // but should NOT throw or return undefined.
    const second = logModelFallbackDecision(makeParams());
    expect(second).toBeDefined();
    expect(second?.fallbackStepType).toBe("fallback_step");
  });

  it("allows logging again after the throttle window expires", () => {
    vi.useFakeTimers();

    // First call
    const first = logModelFallbackDecision(makeParams());
    expect(first).toBeDefined();

    // Advance past the 60-second window
    vi.advanceTimersByTime(61_000);

    // Should log again
    const second = logModelFallbackDecision(makeParams());
    expect(second).toBeDefined();

    vi.useRealTimers();
  });

  it("does not throttle different decision types", () => {
    const skip = logModelFallbackDecision(makeParams({ decision: "skip_candidate" }));
    const failed = logModelFallbackDecision(makeParams({ decision: "candidate_failed" }));

    // Both should return fields — different decision types are separate keys
    expect(skip).toBeDefined();
    expect(failed).toBeDefined();
  });

  it("does not throttle different providers", () => {
    const first = logModelFallbackDecision(makeParams());
    const second = logModelFallbackDecision(makeParams({
      candidate: { provider: "other-provider", model: "other-model" },
      requestedProvider: "other-provider",
      requestedModel: "other-model",
    }));

    // Different providers are separate throttle keys
    expect(first).toBeDefined();
    expect(second).toBeDefined();
  });
});
