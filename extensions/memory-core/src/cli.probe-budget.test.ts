import { describe, expect, it, vi } from "vitest";
import { probeEmbeddingWithBudget } from "./cli.runtime.js";

// Verifies that `memory status --deep` cannot inherit the local-provider
// batch timeout (600 s default) by checking the call-site budget in
// cli.runtime.ts.  When the underlying probe blocks, we must surface a
// parseable `timedOut: true` result so the rendered banner says "timeout"
// rather than "unavailable" and the JSON output stays distinguishable from
// a hard provider failure.
describe("probeEmbeddingWithBudget", () => {
  it("resolves with the manager probe result when it returns within the budget", async () => {
    const manager = {
      probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    };
    const result = await probeEmbeddingWithBudget(manager, 5_000);
    expect(result).toEqual({ ok: true });
    expect(manager.probeEmbeddingAvailability).toHaveBeenCalledTimes(1);
  });

  it("forwards a manager-side failure result without flagging it as a timeout", async () => {
    const manager = {
      probeEmbeddingAvailability: vi.fn(async () => ({
        ok: false,
        error: "provider unreachable",
      })),
    };
    const result = await probeEmbeddingWithBudget(manager, 5_000);
    expect(result).toEqual({ ok: false, error: "provider unreachable" });
    expect(result.timedOut).toBeUndefined();
  });

  it("returns a timed-out result when the manager probe exceeds the budget", async () => {
    const manager = {
      // Never resolves — the budget race is what must complete the call.
      probeEmbeddingAvailability: vi.fn(() => new Promise<{ ok: boolean }>(() => {})),
    };
    const start = Date.now();
    const result = await probeEmbeddingWithBudget(manager, 50);
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toMatch(/Embedding probe exceeded 50ms diagnostic budget/);
    // The race must not extend much beyond the budget.  Generous ceiling to
    // tolerate slow CI runners while still catching obvious regressions.
    expect(elapsed).toBeLessThan(2_000);
  });
});
