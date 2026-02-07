import { describe, expect, it } from "vitest";
import {
  buildSummaryFallback,
  estimateOutputTokens,
  inferOutputRole,
  OUTPUT_BUDGET_DEFAULTS,
  resolveOutputBudget,
  validateOutputBudget,
} from "./output-budget.js";

describe("resolveOutputBudget", () => {
  it("returns defaults for each role", () => {
    expect(resolveOutputBudget({ role: "dispatcher" })).toBe(800);
    expect(resolveOutputBudget({ role: "planner" })).toBe(2000);
    expect(resolveOutputBudget({ role: "executor" })).toBe(1200);
    expect(resolveOutputBudget({ role: "reasoner" })).toBe(1800);
    expect(resolveOutputBudget({ role: "maintenance" })).toBe(600);
  });

  it("respects config overrides", () => {
    expect(resolveOutputBudget({ role: "dispatcher", configOverrides: { dispatcher: 500 } })).toBe(
      500,
    );
  });

  it("ignores invalid overrides (NaN, negative, zero)", () => {
    expect(resolveOutputBudget({ role: "dispatcher", configOverrides: { dispatcher: NaN } })).toBe(
      800,
    );
    expect(resolveOutputBudget({ role: "dispatcher", configOverrides: { dispatcher: -1 } })).toBe(
      800,
    );
    expect(resolveOutputBudget({ role: "dispatcher", configOverrides: { dispatcher: 0 } })).toBe(
      800,
    );
  });

  it("floors fractional overrides", () => {
    expect(resolveOutputBudget({ role: "executor", configOverrides: { executor: 1500.7 } })).toBe(
      1500,
    );
  });
});

describe("estimateOutputTokens", () => {
  it("returns a positive number for non-empty text", () => {
    const tokens = estimateOutputTokens("Hello, world!");
    expect(tokens).toBeGreaterThan(0);
  });

  it("returns a small number for short text", () => {
    const tokens = estimateOutputTokens("ok");
    expect(tokens).toBeLessThan(50);
  });

  it("scales with text length", () => {
    const short = estimateOutputTokens("short");
    const long = estimateOutputTokens("a ".repeat(500));
    expect(long).toBeGreaterThan(short);
  });
});

describe("validateOutputBudget", () => {
  it("returns null when within budget", () => {
    const result = validateOutputBudget({
      role: "dispatcher",
      output: "Quick reply",
    });
    expect(result).toBeNull();
  });

  it("detects budget violation for large output", () => {
    // Generate output that exceeds 600 token budget for maintenance
    const largeOutput = "word ".repeat(1000);
    const result = validateOutputBudget({
      role: "maintenance",
      output: largeOutput,
    });
    expect(result).not.toBeNull();
    expect(result?.role).toBe("maintenance");
    expect(result?.maxTokens).toBe(600);
    expect(result?.actualTokens).toBeGreaterThan(600);
    expect(result?.action).toBe("summary_fallback");
  });

  it("respects per-role limits", () => {
    // Generate output that exceeds dispatcher (800) but fits planner (2000)
    // estimateTokens returns ~1.25 tokens per "word ", so 1000 repeats ≈ 1250 tokens
    const moderateOutput = "word ".repeat(1000);
    const asDispatcher = validateOutputBudget({
      role: "dispatcher",
      output: moderateOutput,
    });
    const asPlanner = validateOutputBudget({
      role: "planner",
      output: moderateOutput,
    });
    // Dispatcher (800) should violate, planner (2000) should not
    expect(asDispatcher).not.toBeNull();
    expect(asPlanner).toBeNull();
  });
});

describe("inferOutputRole", () => {
  it("returns dispatcher for main sessions", () => {
    expect(inferOutputRole({ sessionKey: "agent:main:main" })).toBe("dispatcher");
  });

  it("returns executor for generic subagent sessions", () => {
    expect(inferOutputRole({ sessionKey: "agent:main:subagent:abc-123" })).toBe("executor");
  });

  it("returns planner when label contains plan", () => {
    expect(
      inferOutputRole({
        sessionKey: "agent:main:subagent:abc-123",
        subagentLabel: "planning-task",
      }),
    ).toBe("planner");
  });

  it("returns reasoner when label contains reason/analysis", () => {
    expect(
      inferOutputRole({
        sessionKey: "agent:main:subagent:abc-123",
        subagentLabel: "deep-reasoning",
      }),
    ).toBe("reasoner");
    expect(
      inferOutputRole({
        sessionKey: "agent:main:subagent:abc-123",
        subagentLabel: "code-analysis",
      }),
    ).toBe("reasoner");
  });

  it("returns maintenance for cron sessions", () => {
    expect(inferOutputRole({ sessionKey: "cron:daily-check" })).toBe("maintenance");
  });

  it("returns maintenance for heartbeat sessions", () => {
    expect(inferOutputRole({ sessionKey: "heartbeat:abc" })).toBe("maintenance");
  });

  it("returns undefined when no session key", () => {
    expect(inferOutputRole({})).toBeUndefined();
  });
});

describe("buildSummaryFallback", () => {
  const violation = {
    role: "executor" as const,
    maxTokens: 1200,
    actualTokens: 3000,
    action: "summary_fallback" as const,
  };

  it("includes violation header", () => {
    const fallback = buildSummaryFallback({
      role: "executor",
      output: "some long output",
      violation,
    });
    expect(fallback).toContain("Output budget exceeded");
    expect(fallback).toContain("3000 tokens");
    expect(fallback).toContain("1200 max");
  });

  it("includes artifact reference when provided", () => {
    const fallback = buildSummaryFallback({
      role: "executor",
      output: "some output",
      violation,
      artifactId: "abc123sha",
    });
    expect(fallback).toContain("abc123sha");
    expect(fallback).toContain("artifacts.get");
  });

  it("does not include artifact ref when not provided", () => {
    const fallback = buildSummaryFallback({
      role: "executor",
      output: "some output",
      violation,
    });
    expect(fallback).not.toContain("artifacts.get");
  });

  it("truncates long output in summary", () => {
    const longOutput = "x".repeat(5000);
    const fallback = buildSummaryFallback({
      role: "executor",
      output: longOutput,
      violation,
    });
    expect(fallback.length).toBeLessThan(longOutput.length);
    expect(fallback).toContain("…");
  });
});

describe("OUTPUT_BUDGET_DEFAULTS", () => {
  it("has all required roles", () => {
    expect(OUTPUT_BUDGET_DEFAULTS).toHaveProperty("dispatcher");
    expect(OUTPUT_BUDGET_DEFAULTS).toHaveProperty("planner");
    expect(OUTPUT_BUDGET_DEFAULTS).toHaveProperty("executor");
    expect(OUTPUT_BUDGET_DEFAULTS).toHaveProperty("reasoner");
    expect(OUTPUT_BUDGET_DEFAULTS).toHaveProperty("maintenance");
  });

  it("all values are positive integers", () => {
    for (const [, value] of Object.entries(OUTPUT_BUDGET_DEFAULTS)) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});
