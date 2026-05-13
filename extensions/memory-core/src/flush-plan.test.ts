import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS_MAX,
  buildMemoryFlushPlan,
  defaultMemoryFlushSoftThresholdTokens,
} from "./flush-plan.js";

describe("defaultMemoryFlushSoftThresholdTokens", () => {
  it("returns the legacy floor when no context window is provided", () => {
    expect(defaultMemoryFlushSoftThresholdTokens()).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(defaultMemoryFlushSoftThresholdTokens(undefined)).toBe(
      DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
    );
  });

  it("returns the legacy floor for invalid or non-positive windows", () => {
    expect(defaultMemoryFlushSoftThresholdTokens(0)).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(defaultMemoryFlushSoftThresholdTokens(-1)).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(defaultMemoryFlushSoftThresholdTokens(Number.NaN)).toBe(
      DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
    );
    expect(defaultMemoryFlushSoftThresholdTokens(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
    );
  });

  it("keeps the legacy floor for small windows where 70% would be smaller", () => {
    // 4000 / 0.7 = 5714.28 → any window <= 5714 stays at the legacy floor.
    expect(defaultMemoryFlushSoftThresholdTokens(4000)).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
    expect(defaultMemoryFlushSoftThresholdTokens(5000)).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
  });

  it("scales with the window once 70% exceeds the legacy floor", () => {
    expect(defaultMemoryFlushSoftThresholdTokens(10_000)).toBe(7_000);
    expect(defaultMemoryFlushSoftThresholdTokens(200_000)).toBe(140_000);
    expect(defaultMemoryFlushSoftThresholdTokens(500_000)).toBe(350_000);
  });

  it("caps at DEFAULT_MEMORY_FLUSH_SOFT_TOKENS_MAX for very large windows", () => {
    // 1_000_000 * 0.7 = 700_000, still under the 900_000 cap.
    expect(defaultMemoryFlushSoftThresholdTokens(1_000_000)).toBe(700_000);
    // 2_000_000 * 0.7 = 1_400_000, capped.
    expect(defaultMemoryFlushSoftThresholdTokens(2_000_000)).toBe(
      DEFAULT_MEMORY_FLUSH_SOFT_TOKENS_MAX,
    );
    expect(defaultMemoryFlushSoftThresholdTokens(10_000_000)).toBe(
      DEFAULT_MEMORY_FLUSH_SOFT_TOKENS_MAX,
    );
  });
});

describe("buildMemoryFlushPlan softThresholdTokens default", () => {
  it("uses the legacy default when caller does not provide modelContextWindowTokens", () => {
    const plan = buildMemoryFlushPlan({});
    expect(plan).not.toBeNull();
    expect(plan!.softThresholdTokens).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);
  });

  it("scales the default with modelContextWindowTokens when provided", () => {
    const plan = buildMemoryFlushPlan({ modelContextWindowTokens: 200_000 });
    expect(plan!.softThresholdTokens).toBe(140_000);
  });

  it("caps the scaled default at DEFAULT_MEMORY_FLUSH_SOFT_TOKENS_MAX", () => {
    // 5_000_000 * 0.7 = 3_500_000 → capped at 900_000.
    const plan = buildMemoryFlushPlan({ modelContextWindowTokens: 5_000_000 });
    expect(plan!.softThresholdTokens).toBe(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS_MAX);
  });

  it("still honors an explicit operator-set softThresholdTokens override", () => {
    const plan = buildMemoryFlushPlan({
      modelContextWindowTokens: 1_000_000,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                softThresholdTokens: 12_345,
              },
            },
          },
        },
      },
    });
    expect(plan!.softThresholdTokens).toBe(12_345);
  });

  it("returns null when memory flush is explicitly disabled regardless of window", () => {
    const plan = buildMemoryFlushPlan({
      modelContextWindowTokens: 1_000_000,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                enabled: false,
              },
            },
          },
        },
      },
    });
    expect(plan).toBeNull();
  });
});
