import { describe, expect, it } from "vitest";
import {
  applyTemporalDecayToHybridResults,
  applyTemporalDecayToScore,
  calculateTemporalDecayMultiplier,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

const NOW_MS = Date.UTC(2026, 3, 25, 0, 0, 0);

describe("calculateTemporalDecayMultiplier — Weibull model", () => {
  it("returns 1.0 at age 0 regardless of shape", () => {
    for (const shape of [0.5, 1, 1.5, 3]) {
      const m = calculateTemporalDecayMultiplier({
        ageInDays: 0,
        halfLifeDays: 14,
        model: "weibull",
        weibullShape: shape,
      });
      expect(m).toBeCloseTo(1, 10);
    }
  });

  it("halves at t = halfLife for any shape (preserves half-life semantics)", () => {
    for (const shape of [0.5, 1, 1.5, 3]) {
      const m = calculateTemporalDecayMultiplier({
        ageInDays: 14,
        halfLifeDays: 14,
        model: "weibull",
        weibullShape: shape,
      });
      expect(m).toBeCloseTo(0.5, 10);
    }
  });

  it("degenerates to exponential when shape = 1", () => {
    for (const age of [1, 5, 14, 30, 100]) {
      const weibull = calculateTemporalDecayMultiplier({
        ageInDays: age,
        halfLifeDays: 14,
        model: "weibull",
        weibullShape: 1,
      });
      const exponential = calculateTemporalDecayMultiplier({
        ageInDays: age,
        halfLifeDays: 14,
        model: "exponential",
      });
      expect(weibull).toBeCloseTo(exponential, 10);
    }
  });

  it("shape > 1 retains more before half-life, decays more after", () => {
    const halfLifeDays = 14;
    const early = 3;
    const late = 60;

    const weibullEarly = calculateTemporalDecayMultiplier({
      ageInDays: early,
      halfLifeDays,
      model: "weibull",
      weibullShape: 1.5,
    });
    const exponentialEarly = calculateTemporalDecayMultiplier({
      ageInDays: early,
      halfLifeDays,
      model: "exponential",
    });
    const weibullLate = calculateTemporalDecayMultiplier({
      ageInDays: late,
      halfLifeDays,
      model: "weibull",
      weibullShape: 1.5,
    });
    const exponentialLate = calculateTemporalDecayMultiplier({
      ageInDays: late,
      halfLifeDays,
      model: "exponential",
    });

    // ratio < 1 ⇒ ratio^β < ratio for β>1 ⇒ exponent is smaller ⇒ multiplier is larger
    expect(weibullEarly).toBeGreaterThan(exponentialEarly);
    // ratio > 1 ⇒ ratio^β > ratio for β>1 ⇒ exponent is larger ⇒ multiplier is smaller
    expect(weibullLate).toBeLessThan(exponentialLate);
  });

  it("is monotonically non-increasing in age under Weibull", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const age of [0, 1, 3, 7, 14, 30, 90, 365]) {
      const m = calculateTemporalDecayMultiplier({
        ageInDays: age,
        halfLifeDays: 14,
        model: "weibull",
        weibullShape: 1.5,
      });
      expect(m).toBeLessThanOrEqual(prev + 1e-12);
      prev = m;
    }
  });

  it("clamps Weibull shape above the max and below the min", () => {
    // Shape = 1000 should clamp to max (5). Compare against shape = 5 directly.
    const mHuge = calculateTemporalDecayMultiplier({
      ageInDays: 7,
      halfLifeDays: 14,
      model: "weibull",
      weibullShape: 1000,
    });
    const mMax = calculateTemporalDecayMultiplier({
      ageInDays: 7,
      halfLifeDays: 14,
      model: "weibull",
      weibullShape: 5,
    });
    expect(mHuge).toBeCloseTo(mMax, 10);

    // Shape = 0.0001 should clamp to min (0.1). Compare against shape = 0.1.
    const mTiny = calculateTemporalDecayMultiplier({
      ageInDays: 7,
      halfLifeDays: 14,
      model: "weibull",
      weibullShape: 0.0001,
    });
    const mMin = calculateTemporalDecayMultiplier({
      ageInDays: 7,
      halfLifeDays: 14,
      model: "weibull",
      weibullShape: 0.1,
    });
    expect(mTiny).toBeCloseTo(mMin, 10);
  });

  it("falls back to default shape for invalid inputs (NaN, 0, negative)", () => {
    const mDefault = calculateTemporalDecayMultiplier({
      ageInDays: 7,
      halfLifeDays: 14,
      model: "weibull",
      weibullShape: DEFAULT_TEMPORAL_DECAY_CONFIG.weibullShape,
    });

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const m = calculateTemporalDecayMultiplier({
        ageInDays: 7,
        halfLifeDays: 14,
        model: "weibull",
        weibullShape: bad,
      });
      expect(m).toBeCloseTo(mDefault, 10);
    }
  });

  it("returns 1 when halfLife is non-positive or non-finite, even in Weibull mode", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const m = calculateTemporalDecayMultiplier({
        ageInDays: 10,
        halfLifeDays: bad,
        model: "weibull",
        weibullShape: 1.5,
      });
      expect(m).toBe(1);
    }
  });

  it("treats omitted model as exponential (backward compatible)", () => {
    const age = 7;
    const halfLifeDays = 14;
    const legacy = calculateTemporalDecayMultiplier({ ageInDays: age, halfLifeDays });
    const explicit = calculateTemporalDecayMultiplier({
      ageInDays: age,
      halfLifeDays,
      model: "exponential",
    });
    expect(legacy).toBeCloseTo(explicit, 10);
  });
});

describe("applyTemporalDecayToScore — Weibull model", () => {
  it("scales score by Weibull multiplier at half-life", () => {
    const scored = applyTemporalDecayToScore({
      score: 0.8,
      ageInDays: 14,
      halfLifeDays: 14,
      model: "weibull",
      weibullShape: 1.5,
    });
    expect(scored).toBeCloseTo(0.8 * 0.5, 10);
  });

  it("preserves score at age 0 for any shape", () => {
    for (const shape of [0.5, 1, 1.5, 3]) {
      const scored = applyTemporalDecayToScore({
        score: 0.9,
        ageInDays: 0,
        halfLifeDays: 14,
        model: "weibull",
        weibullShape: shape,
      });
      expect(scored).toBeCloseTo(0.9, 10);
    }
  });
});

describe("applyTemporalDecayToHybridResults — Weibull integration", () => {
  const memoryEntry = (relPath: string, score = 1) => ({
    path: relPath,
    score,
    source: "memory" as const,
  });

  it("is a no-op when enabled=false even if Weibull is configured", async () => {
    const out = await applyTemporalDecayToHybridResults({
      results: [memoryEntry("memory/2026-04-01.md", 0.9)],
      temporalDecay: { enabled: false, model: "weibull", weibullShape: 1.5 },
      nowMs: NOW_MS,
    });
    expect(out[0]?.score).toBe(0.9);
  });

  it("exponential (legacy default) and Weibull with shape=1 produce identical scores", async () => {
    const results = [
      memoryEntry("memory/2026-04-11.md", 1), // 14 days old
      memoryEntry("memory/2026-03-26.md", 1), // 30 days old
    ];

    const viaLegacy = await applyTemporalDecayToHybridResults({
      results: results.map((r) => ({ ...r })),
      temporalDecay: { enabled: true, halfLifeDays: 14 },
      nowMs: NOW_MS,
    });
    const viaExplicitExp = await applyTemporalDecayToHybridResults({
      results: results.map((r) => ({ ...r })),
      temporalDecay: { enabled: true, halfLifeDays: 14, model: "exponential" },
      nowMs: NOW_MS,
    });
    const viaWeibullOne = await applyTemporalDecayToHybridResults({
      results: results.map((r) => ({ ...r })),
      temporalDecay: { enabled: true, halfLifeDays: 14, model: "weibull", weibullShape: 1 },
      nowMs: NOW_MS,
    });

    for (let i = 0; i < results.length; i++) {
      expect(viaLegacy[i]?.score).toBeCloseTo(viaExplicitExp[i]?.score ?? 0, 10);
      expect(viaWeibullOne[i]?.score).toBeCloseTo(viaExplicitExp[i]?.score ?? 0, 10);
    }
  });

  it("applies Weibull to dated memory files (half-life ⇒ 0.5 × score)", async () => {
    // Entry is exactly 14 days old relative to NOW_MS; halfLifeDays=14 ⇒ 0.5 for any β.
    const out = await applyTemporalDecayToHybridResults({
      results: [memoryEntry("memory/2026-04-11.md", 0.9)],
      temporalDecay: {
        enabled: true,
        halfLifeDays: 14,
        model: "weibull",
        weibullShape: 1.5,
      },
      nowMs: NOW_MS,
    });
    expect(out[0]?.score).toBeCloseTo(0.45, 6);
  });

  it("evergreen MEMORY.md and topic files are not decayed under Weibull", async () => {
    const out = await applyTemporalDecayToHybridResults({
      results: [memoryEntry("MEMORY.md", 0.7), memoryEntry("memory/projects.md", 0.8)],
      temporalDecay: {
        enabled: true,
        halfLifeDays: 1,
        model: "weibull",
        weibullShape: 2,
      },
      nowMs: NOW_MS,
    });
    expect(out[0]?.score).toBe(0.7);
    expect(out[1]?.score).toBe(0.8);
  });

  it("higher β penalizes very old dated memories more than exponential", async () => {
    // 180 days old, halfLife 14 ⇒ ratio 12.86. exp(-ln2*12.86^1.5) ≪ exp(-ln2*12.86).
    const input = () => [memoryEntry("memory/2025-10-27.md", 1)];

    const decayedExp = await applyTemporalDecayToHybridResults({
      results: input(),
      temporalDecay: { enabled: true, halfLifeDays: 14, model: "exponential" },
      nowMs: NOW_MS,
    });
    const decayedWeibull = await applyTemporalDecayToHybridResults({
      results: input(),
      temporalDecay: {
        enabled: true,
        halfLifeDays: 14,
        model: "weibull",
        weibullShape: 1.5,
      },
      nowMs: NOW_MS,
    });

    expect(decayedWeibull[0]?.score ?? 1).toBeLessThan(decayedExp[0]?.score ?? 1);
  });
});
