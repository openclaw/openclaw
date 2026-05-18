/**
 * Phase 8 tests: per-turn tool call limit guard.
 *
 * Covers the pure helpers in agent-tool-call-turn-guard.ts and the wiring
 * contract — ensuring that default/backcompat, under-limit, at-limit, and
 * over-limit cases all behave correctly, and that no path throws.
 */

import { describe, expect, it } from "vitest";
import {
  buildToolCallLimitWarning,
  isToolCallLimitExceeded,
  MAX_TOOL_CALLS_PER_TURN_CONSERVATIVE,
  MAX_TOOL_CALLS_PER_TURN_DISABLED,
} from "./agent-tool-call-turn-guard.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Phase 8 constants", () => {
  it("MAX_TOOL_CALLS_PER_TURN_DISABLED is 0", () => {
    expect(MAX_TOOL_CALLS_PER_TURN_DISABLED).toBe(0);
  });

  it("MAX_TOOL_CALLS_PER_TURN_CONSERVATIVE is a positive integer", () => {
    expect(MAX_TOOL_CALLS_PER_TURN_CONSERVATIVE).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_TOOL_CALLS_PER_TURN_CONSERVATIVE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isToolCallLimitExceeded — disabled (limit=0)
// ---------------------------------------------------------------------------

describe("Phase 8 isToolCallLimitExceeded — disabled", () => {
  it("returns false when limit is 0 regardless of count (default off)", () => {
    expect(isToolCallLimitExceeded(0, 0)).toBe(false);
  });

  it("returns false for count=1 when limit=0", () => {
    expect(isToolCallLimitExceeded(1, 0)).toBe(false);
  });

  it("returns false for very high count when limit=0 (backcompat guard)", () => {
    expect(isToolCallLimitExceeded(1000, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isToolCallLimitExceeded — under limit
// ---------------------------------------------------------------------------

describe("Phase 8 isToolCallLimitExceeded — under limit", () => {
  it("returns false when count is below the limit", () => {
    expect(isToolCallLimitExceeded(4, 5)).toBe(false);
  });

  it("returns false for count=0 with any positive limit", () => {
    expect(isToolCallLimitExceeded(0, 25)).toBe(false);
  });

  it("returns false when count is 1 below the limit", () => {
    expect(isToolCallLimitExceeded(24, 25)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isToolCallLimitExceeded — at or over limit
// ---------------------------------------------------------------------------

describe("Phase 8 isToolCallLimitExceeded — at limit", () => {
  it("returns true when count exactly equals the limit", () => {
    expect(isToolCallLimitExceeded(5, 5)).toBe(true);
  });

  it("returns true when count is above the limit", () => {
    expect(isToolCallLimitExceeded(10, 5)).toBe(true);
  });

  it("returns true for count=25 with CONSERVATIVE limit", () => {
    expect(isToolCallLimitExceeded(25, MAX_TOOL_CALLS_PER_TURN_CONSERVATIVE)).toBe(true);
  });

  it("returns true for count well above the limit (runaway loop scenario)", () => {
    expect(isToolCallLimitExceeded(200, 25)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildToolCallLimitWarning
// ---------------------------------------------------------------------------

describe("Phase 8 buildToolCallLimitWarning — content", () => {
  it("includes the TOOL_LOOP_GUARD sentinel prefix", () => {
    const warning = buildToolCallLimitWarning({ toolName: "read", count: 5, limit: 5 });
    expect(warning).toContain("[TOOL_LOOP_GUARD]");
  });

  it("includes the count in the warning", () => {
    const warning = buildToolCallLimitWarning({ toolName: "exec", count: 10, limit: 10 });
    expect(warning).toContain("10");
  });

  it("includes the limit in the warning", () => {
    const warning = buildToolCallLimitWarning({ toolName: "exec", count: 10, limit: 10 });
    expect(warning).toContain("10 of 10");
  });

  it("includes the tool name in the warning", () => {
    const warning = buildToolCallLimitWarning({ toolName: "write", count: 3, limit: 3 });
    expect(warning).toContain("write");
  });

  it("tells the model to stop calling tools", () => {
    const warning = buildToolCallLimitWarning({ toolName: "read", count: 5, limit: 5 });
    expect(warning.toLowerCase()).toContain("stop");
  });

  it("tells the model to summarize", () => {
    const warning = buildToolCallLimitWarning({ toolName: "read", count: 5, limit: 5 });
    expect(warning.toLowerCase()).toContain("summarize");
  });

  it("is a non-empty string", () => {
    const warning = buildToolCallLimitWarning({ toolName: "lark", count: 25, limit: 25 });
    expect(warning.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildToolCallLimitWarning — safety (no throw)
// ---------------------------------------------------------------------------

describe("Phase 8 buildToolCallLimitWarning — safety", () => {
  it("does not throw for normal inputs", () => {
    expect(() => buildToolCallLimitWarning({ toolName: "read", count: 5, limit: 5 })).not.toThrow();
  });

  it("does not throw for empty tool name", () => {
    expect(() => buildToolCallLimitWarning({ toolName: "", count: 1, limit: 1 })).not.toThrow();
  });

  it("does not throw for zero count (edge case)", () => {
    expect(() => buildToolCallLimitWarning({ toolName: "exec", count: 0, limit: 0 })).not.toThrow();
  });

  it("does not throw for very large count (runaway loop scenario)", () => {
    expect(() =>
      buildToolCallLimitWarning({ toolName: "exec", count: 9999, limit: 25 }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Per-turn reset contract (wiring-level proof without runtime imports)
// ---------------------------------------------------------------------------

describe("Phase 8 per-turn reset contract", () => {
  it("counter incremented before limit check: count=limit triggers exceeded", () => {
    // Simulates what handleToolExecutionEnd does: counter is incremented
    // THEN checked. So reaching count===limit (not count>limit) triggers the guard.
    let callsThisTurn = 0;
    const maxToolCallsPerTurn = 3;

    // First three calls: not exceeded
    for (let i = 0; i < 2; i++) {
      callsThisTurn += 1;
      expect(isToolCallLimitExceeded(callsThisTurn, maxToolCallsPerTurn)).toBe(false);
    }
    // Third call reaches the limit
    callsThisTurn += 1;
    expect(callsThisTurn).toBe(3);
    expect(isToolCallLimitExceeded(callsThisTurn, maxToolCallsPerTurn)).toBe(true);

    // Simulate message_start reset
    callsThisTurn = 0;
    expect(isToolCallLimitExceeded(callsThisTurn, maxToolCallsPerTurn)).toBe(false);
  });

  it("after reset, first tool call of new turn is not exceeded", () => {
    let callsThisTurn = 0;
    const maxToolCallsPerTurn = 2;

    // Fill up the turn
    callsThisTurn += 1;
    callsThisTurn += 1;
    expect(isToolCallLimitExceeded(callsThisTurn, maxToolCallsPerTurn)).toBe(true);

    // New turn (message_start)
    callsThisTurn = 0;
    callsThisTurn += 1; // first tool call of new turn
    expect(isToolCallLimitExceeded(callsThisTurn, maxToolCallsPerTurn)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backcompat: existing callers without maxToolCallsPerTurn
// ---------------------------------------------------------------------------

describe("Phase 8 backcompat", () => {
  it("limit=0 (default) never triggers the guard for any call count", () => {
    const limit = 0; // default when param is omitted: ctx.params.maxToolCallsPerTurn ?? 0
    for (const count of [1, 5, 25, 100, 1000]) {
      expect(isToolCallLimitExceeded(count, limit)).toBe(false);
    }
  });

  it("warning is only built when exceeded (no limitWarning allocation for normal calls)", () => {
    const limit = 0;
    const exceeded = isToolCallLimitExceeded(999, limit);
    // Simulate the guard branch in handleToolExecutionEnd:
    // limitWarning = exceeded ? buildToolCallLimitWarning(...) : undefined
    const limitWarning = exceeded
      ? buildToolCallLimitWarning({ toolName: "read", count: 999, limit })
      : undefined;
    expect(limitWarning).toBeUndefined();
  });
});
