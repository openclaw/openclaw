import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GradualScaleIn } from "./gradual-scale-in.js";

describe("GradualScaleIn", () => {
  let scaleIn: GradualScaleIn;

  beforeEach(() => {
    scaleIn = new GradualScaleIn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initiates at phase 1 with 25% capital", () => {
    const state = scaleIn.initiate("strat-1");
    expect(state.phase).toBe(1);
    expect(state.capitalPct).toBe(0.25);
    expect(state.phaseSharpe).toBe(0);
  });

  it("getPhase returns undefined for unknown strategy", () => {
    expect(scaleIn.getPhase("unknown")).toBeUndefined();
  });

  it("getCapitalMultiplier returns 1.0 for unknown strategy", () => {
    expect(scaleIn.getCapitalMultiplier("unknown")).toBe(1.0);
  });

  it("getCapitalMultiplier returns correct value per phase", () => {
    scaleIn.initiate("strat-1");
    expect(scaleIn.getCapitalMultiplier("strat-1")).toBe(0.25);
  });

  it("shouldAdvance returns false if less than 7 days", () => {
    const state = scaleIn.initiate("strat-1");
    state.phaseSharpe = 1.0;
    // Only 3 days elapsed
    vi.advanceTimersByTime(3 * 86_400_000);
    expect(scaleIn.shouldAdvance(state)).toBe(false);
  });

  it("shouldAdvance returns false if phaseSharpe <= 0", () => {
    const state = scaleIn.initiate("strat-1");
    state.phaseSharpe = -0.5;
    vi.advanceTimersByTime(10 * 86_400_000);
    expect(scaleIn.shouldAdvance(state)).toBe(false);
  });

  it("shouldAdvance returns true when conditions met", () => {
    const state = scaleIn.initiate("strat-1");
    state.phaseSharpe = 0.5;
    vi.advanceTimersByTime(8 * 86_400_000);
    expect(scaleIn.shouldAdvance(state)).toBe(true);
  });

  it("shouldAdvance returns false at phase 3", () => {
    const state = scaleIn.initiate("strat-1");
    // Force to phase 3
    (state as { phase: number }).phase = 3;
    state.phaseSharpe = 1.0;
    vi.advanceTimersByTime(10 * 86_400_000);
    expect(scaleIn.shouldAdvance(state)).toBe(false);
  });

  it("advance transitions phase 1 → 2 → 3", () => {
    scaleIn.initiate("strat-1");
    const s1 = scaleIn.getPhase("strat-1")!;
    s1.phaseSharpe = 1.0;
    vi.advanceTimersByTime(8 * 86_400_000);

    const s2 = scaleIn.advance("strat-1");
    expect(s2?.phase).toBe(2);
    expect(s2?.capitalPct).toBe(0.5);
    expect(scaleIn.getCapitalMultiplier("strat-1")).toBe(0.5);

    // Advance again
    s2!.phaseSharpe = 0.8;
    vi.advanceTimersByTime(8 * 86_400_000);

    const s3 = scaleIn.advance("strat-1");
    expect(s3?.phase).toBe(3);
    expect(s3?.capitalPct).toBe(1.0);
    expect(scaleIn.getCapitalMultiplier("strat-1")).toBe(1.0);
  });

  it("advance returns undefined if conditions not met", () => {
    scaleIn.initiate("strat-1");
    // No time elapsed, no sharpe
    expect(scaleIn.advance("strat-1")).toBeUndefined();
  });

  it("advance returns undefined at phase 3", () => {
    scaleIn.initiate("strat-1");
    const s = scaleIn.getPhase("strat-1")!;
    (s as { phase: number }).phase = 3;
    s.phaseSharpe = 1.0;
    vi.advanceTimersByTime(10 * 86_400_000);
    expect(scaleIn.advance("strat-1")).toBeUndefined();
  });
});
