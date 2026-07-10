// Memory Core tests cover manager batch state plugin behavior.
import { describe, expect, it } from "vitest";
import {
  MEMORY_BATCH_FAILURE_LIMIT,
  recordMemoryBatchFailure,
  resetMemoryBatchFailureState,
} from "./manager-batch-state.js";

describe("memory batch state", () => {
  it("resets failures after recovery", () => {
    expect(
      resetMemoryBatchFailureState({
        enabled: true,
        count: 1,
        lastError: "batch failed",
        lastProvider: "openai",
      }),
    ).toEqual({
      enabled: true,
      count: 0,
      lastError: undefined,
      lastProvider: undefined,
    });
  });

  it("disables batching after repeated failures", () => {
    const once = recordMemoryBatchFailure(
      { enabled: true, count: 0 },
      { provider: "openai", message: "batch failed", attempts: 1 },
    );
    expect(once).toEqual({
      enabled: true,
      count: 1,
      lastError: "batch failed",
      lastProvider: "openai",
    });

    const twice = recordMemoryBatchFailure(once, {
      provider: "openai",
      message: "batch failed again",
      attempts: 1,
    });
    expect(twice).toEqual({
      enabled: false,
      count: MEMORY_BATCH_FAILURE_LIMIT,
      lastError: "batch failed again",
      lastProvider: "openai",
    });
  });

  it("force-disables batching immediately", () => {
    expect(
      recordMemoryBatchFailure(
        { enabled: true, count: 0 },
        { provider: "gemini", message: "not available", forceDisable: true },
      ),
    ).toEqual({
      enabled: false,
      count: MEMORY_BATCH_FAILURE_LIMIT,
      lastError: "not available",
      lastProvider: "gemini",
    });
  });

  it("honors valid positive safe-integer attempt counts", () => {
    expect(
      recordMemoryBatchFailure(
        { enabled: true, count: 0 },
        { provider: "openai", message: "batch failed", attempts: 2 },
      ),
    ).toEqual({
      enabled: false,
      count: 2,
      lastError: "batch failed",
      lastProvider: "openai",
    });
  });

  it("treats malformed attempt counts as one failed attempt", () => {
    const malformed = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      0,
      -3,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const attempts of malformed) {
      expect(
        recordMemoryBatchFailure(
          { enabled: true, count: 0 },
          { provider: "openai", message: "batch failed", attempts },
        ),
      ).toEqual({
        enabled: true,
        count: 1,
        lastError: "batch failed",
        lastProvider: "openai",
      });
    }
  });

  it("still disables batching after repeated malformed-attempt failures", () => {
    let state = recordMemoryBatchFailure(
      { enabled: true, count: 0 },
      { provider: "openai", message: "first", attempts: Number.NaN },
    );
    expect(state.enabled).toBe(true);
    expect(state.count).toBe(1);
    state = recordMemoryBatchFailure(state, {
      provider: "openai",
      message: "second",
      attempts: Number.NaN,
    });
    expect(state.enabled).toBe(false);
    expect(state.count).toBe(MEMORY_BATCH_FAILURE_LIMIT);
  });

  it("leaves disabled state unchanged", () => {
    expect(
      recordMemoryBatchFailure(
        { enabled: false, count: MEMORY_BATCH_FAILURE_LIMIT, lastError: "x", lastProvider: "y" },
        { provider: "openai", message: "ignored" },
      ),
    ).toEqual({
      enabled: false,
      count: MEMORY_BATCH_FAILURE_LIMIT,
      lastError: "x",
      lastProvider: "y",
    });
  });
});
