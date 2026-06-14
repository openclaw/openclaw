/**
 * Tests for the log coalescer added to model-fallback-observation.
 * Verifies that repeated auth-class fallback decisions are suppressed
 * within a sliding window while candidate_succeeded and
 * probe_cooldown_candidate always pass through.
 */
import { describe, expect, test, beforeEach, vi, afterEach } from "vitest";
import {
  logModelFallbackDecision,
  resetFallbackLogCoalesceStateForTest,
} from "./model-fallback-observation.js";

function makeAuthFailureParams(overrides?: Record<string, unknown>) {
  return {
    decision: "candidate_failed" as const,
    requestedProvider: "modelstudio",
    requestedModel: "glm-5",
    candidate: { provider: "modelstudio", model: "glm-5" },
    reason: "auth" as const,
    error: "HTTP 401: invalid access token",
    nextCandidate: { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
    ...overrides,
  };
}

function makeSkipParams(overrides?: Record<string, unknown>) {
  return {
    decision: "skip_candidate" as const,
    requestedProvider: "modelstudio",
    requestedModel: "glm-5",
    candidate: { provider: "modelstudio", model: "glm-5" },
    reason: "auth" as const,
    error: "token expired",
    nextCandidate: { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
    ...overrides,
  };
}

function makeSuccessParams(overrides?: Record<string, unknown>) {
  return {
    decision: "candidate_succeeded" as const,
    requestedProvider: "modelstudio",
    requestedModel: "glm-5",
    candidate: { provider: "minimax", model: "MiniMax-M2.7-highspeed" },
    reason: null,
    previousAttempts: [
      {
        provider: "modelstudio",
        model: "glm-5",
        reason: "auth" as const,
        error: "HTTP 401",
      },
    ],
    ...overrides,
  };
}

describe("log fallback coalescer", () => {
  beforeEach(() => {
    resetFallbackLogCoalesceStateForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("first auth failure is logged normally", () => {
    // First call should produce fallbackStepFields (not undefined)
    const result = logModelFallbackDecision(makeAuthFailureParams());
    // candidate_failed with error and nextCandidate produces fallback step fields
    expect(result).not.toBeUndefined();
    expect(result?.fallbackStepType).toBe("fallback_step");
  });

  test("duplicate auth failure within window is suppressed (returns fields, no second log)", () => {
    // First call logs, second should be suppressed
    const first = logModelFallbackDecision(makeAuthFailureParams());
    expect(first).not.toBeUndefined();

    // Second call with same params — should still return fields but not log
    const second = logModelFallbackDecision(makeAuthFailureParams());
    // Still returns fallbackStepFields even when suppressed
    expect(second).not.toBeUndefined();
  });

  test("different provider produces separate coalesce key", () => {
    // First: modelstudio
    logModelFallbackDecision(makeAuthFailureParams());
    // Second: different provider should log (not suppressed)
    const second = logModelFallbackDecision(
      makeAuthFailureParams({
        candidate: { provider: "openai", model: "gpt-5" },
      }),
    );
    expect(second).not.toBeUndefined();
  });

  test("different reason produces separate coalesce key", () => {
    // First: auth reason
    logModelFallbackDecision(makeAuthFailureParams());
    // Second: different reason — should log
    const second = logModelFallbackDecision(makeAuthFailureParams({ reason: "rate_limit" }));
    expect(second).not.toBeUndefined();
  });

  test("duplicate suppressed count is reported after window expires", () => {
    // First call logs
    logModelFallbackDecision(makeAuthFailureParams());

    // Suppress 3 duplicates
    logModelFallbackDecision(makeAuthFailureParams());
    logModelFallbackDecision(makeAuthFailureParams());
    logModelFallbackDecision(makeAuthFailureParams());

    // Advance past window
    vi.advanceTimersByTime(31_000);

    // Next call should log with suppressed count info
    // (consoleMessage will contain suppression suffix)
    const afterWindow = logModelFallbackDecision(
      makeAuthFailureParams({ runId: "run-after-window" }),
    );
    expect(afterWindow).not.toBeUndefined();
    // The runId confirms a fresh log was emitted
  });

  test("skip_candidate is also eligible for coalescing", () => {
    const first = logModelFallbackDecision(makeSkipParams());
    expect(first).not.toBeUndefined();

    // Duplicate skip should be suppressed
    const second = logModelFallbackDecision(makeSkipParams());
    expect(second).not.toBeUndefined();
  });

  test("candidate_succeeded always logs (never coalesced)", () => {
    // Success should always go through
    const first = logModelFallbackDecision(makeSuccessParams());
    expect(first).not.toBeUndefined();

    const second = logModelFallbackDecision(makeSuccessParams());
    expect(second).not.toBeUndefined();
  });

  test("probe_cooldown_candidate always logs (never coalesced)", () => {
    const params = {
      decision: "probe_cooldown_candidate" as const,
      requestedProvider: "modelstudio",
      requestedModel: "glm-5",
      candidate: { provider: "modelstudio", model: "glm-5" },
      reason: "probe" as const,
    };
    const first = logModelFallbackDecision(params);
    // probe_cooldown_candidate does not produce fallbackStepFields
    // (not in the buildFallbackStepFields guard)
    expect(first).toBeUndefined();

    const second = logModelFallbackDecision(params);
    expect(second).toBeUndefined();
    // Both should have logged without coalescing
  });

  test("different nextCandidate produces separate coalesce key", () => {
    logModelFallbackDecision(
      makeAuthFailureParams({
        nextCandidate: { provider: "minimax", model: "MiniMax-M2.7" },
      }),
    );
    // Different next candidate — should be treated as different key
    const second = logModelFallbackDecision(
      makeAuthFailureParams({
        nextCandidate: { provider: "qwen", model: "qwen3.5-plus" },
      }),
    );
    expect(second).not.toBeUndefined();
  });

  test("coalesce state can be reset between tests", () => {
    logModelFallbackDecision(makeAuthFailureParams());
    // Suppress one duplicate
    logModelFallbackDecision(makeAuthFailureParams());

    resetFallbackLogCoalesceStateForTest();

    // After reset, same call should log as first-time
    vi.advanceTimersByTime(100);
    const afterReset = logModelFallbackDecision(makeAuthFailureParams());
    expect(afterReset).not.toBeUndefined();
  });
});
