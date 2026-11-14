// Runtime auth deadline budgets: the withTimeout budget must live in the
// monotonic domain so a backward host clock (NTP correction) cannot stretch it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeAuthDeadline } from "./runtime-auth-refresh.js";

describe("createRuntimeAuthDeadline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not stretch the auth exchange budget when the wall clock moves backward", async () => {
    const timeoutMs = 5000;
    // Seed the wall clock at t0, then rewind it 30s before the deadline is read.
    // Pre-fix, seed and read both used Date.now(), so a backward jump between
    // them inflated remainingMs to timeoutMs + 30000; post-fix the deadline is
    // monotonic and stays capped at timeoutMs.
    // The Date.now spy rewind is consumed by the pre-fix seed/read path to prove
    // RED; post-fix the own-seed deadline is monotonic and never reads the wall
    // clock, so the spy stays unconsumed (that is the point of the fix). The
    // observable contract is the setTimeout budget below.
    let dateNow = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const value = dateNow;
      if (value === 100_000) {
        dateNow = 70_000; // first read (deadline seed) is t0; rewind before the budget read
      }
      return value;
    });
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);

    const deadline = createRuntimeAuthDeadline({ provider: "mock-provider", timeoutMs });
    await deadline.run("exchange", async () => "ok");

    // dateNowSpy is consumed only by the pre-fix seed/read path; post-fix the
    // own-seed deadline is monotonic and never reads the wall clock, which is the
    // point of the fix. The observable contract is the setTimeout budget.
    expect(timeoutSpy).toHaveBeenCalled();
    const budget = timeoutSpy.mock.calls.map((c) => c[1]).find((ms) => ms !== undefined);
    expect(budget).toBeDefined();
    expect(budget!).toBeLessThanOrEqual(timeoutMs);
  });

  it("caps the upstream wall-clock queue deadline to a bounded withTimeout budget", async () => {
    const timeoutMs = 5000;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    // An upstream command-queue deadline carries a wall-clock epoch; it must be
    // converted to the monotonic domain at the boundary, never fed raw to setTimeout.
    const upstreamDeadline = { kind: "bounded" as const, deadlineAtMs: Date.now() + timeoutMs };
    const deadline = createRuntimeAuthDeadline({
      provider: "mock-provider",
      timeoutMs,
      getDeadline: () => upstreamDeadline,
    });
    await deadline.run("exchange", async () => "ok");

    expect(timeoutSpy).toHaveBeenCalled();
    const budget = timeoutSpy.mock.calls.map((c) => c[1]).find((ms) => ms !== undefined);
    expect(budget).toBeDefined();
    expect(budget!).toBeGreaterThan(0);
    expect(budget!).toBeLessThanOrEqual(timeoutMs + 50);
  });
});
