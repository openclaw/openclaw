import { describe, it, expect } from "vitest";
import type { StrategyProfile } from "../fund/types.js";
import { GarbageCollector } from "./garbage-collector.js";
import type { DecayEstimate } from "./types.js";

function makeProfile(overrides: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    id: "strat-1",
    name: "Test Strategy",
    level: "L2_PAPER",
    fitness: 0.5,
    ...overrides,
  };
}

const HEALTHY_METRICS = {
  rollingSharpe7d: 1.0,
  rollingSharpe30d: 0.8,
  sharpeMomentum: 0,
  consecutiveLossDays: 2,
  currentDrawdown: -5,
  peakEquity: 10500,
  decayLevel: "healthy" as const,
};

describe("GarbageCollector", () => {
  const gc = new GarbageCollector();

  it("does not kill healthy strategies", () => {
    const profiles = [
      makeProfile({ paperMetrics: HEALTHY_METRICS, paperTradeCount: 10, paperDaysActive: 30 }),
    ];
    const result = gc.collect(profiles);
    expect(result.killed).toHaveLength(0);
  });

  it("kills strategy with sustained negative 7d Sharpe (< -1)", () => {
    const profiles = [
      makeProfile({
        paperMetrics: { ...HEALTHY_METRICS, rollingSharpe7d: -1.5 },
      }),
    ];
    const result = gc.collect(profiles);
    expect(result.killed).toContain("strat-1");
    expect(result.reasons.get("strat-1")).toContain("sustained negative");
  });

  it("kills strategy with 14+ consecutive loss days", () => {
    const profiles = [
      makeProfile({
        paperMetrics: { ...HEALTHY_METRICS, consecutiveLossDays: 14 },
      }),
    ];
    const result = gc.collect(profiles);
    expect(result.killed).toContain("strat-1");
    expect(result.reasons.get("strat-1")).toContain("consecutive loss days");
  });

  it("kills inactive strategy (0 trades, 14+ days)", () => {
    const profiles = [makeProfile({ paperTradeCount: 0, paperDaysActive: 20 })];
    const result = gc.collect(profiles);
    expect(result.killed).toContain("strat-1");
    expect(result.reasons.get("strat-1")).toContain("inactive");
  });

  it("kills strategy with fast alpha decay (half-life < 15d)", () => {
    const profiles = [
      makeProfile({ paperMetrics: HEALTHY_METRICS, paperTradeCount: 50, paperDaysActive: 30 }),
    ];
    const decayEstimates = new Map<string, DecayEstimate>([
      ["strat-1", { halfLifeDays: 10, decayRate: 0.07, r2: 0.8, classification: "fast-decay" }],
    ]);
    const result = gc.collect(profiles, decayEstimates);
    expect(result.killed).toContain("strat-1");
    expect(result.reasons.get("strat-1")).toContain("fast decay");
  });

  it("skips L0_INCUBATE and KILLED strategies", () => {
    const profiles = [
      makeProfile({
        id: "l0",
        level: "L0_INCUBATE",
        paperMetrics: { ...HEALTHY_METRICS, rollingSharpe7d: -2 },
      }),
      makeProfile({
        id: "dead",
        level: "KILLED",
        paperMetrics: { ...HEALTHY_METRICS, rollingSharpe7d: -2 },
      }),
    ];
    const result = gc.collect(profiles);
    expect(result.killed).toHaveLength(0);
  });

  it("handles multiple profiles with mixed results", () => {
    const profiles = [
      makeProfile({
        id: "healthy",
        paperMetrics: HEALTHY_METRICS,
        paperTradeCount: 10,
        paperDaysActive: 30,
      }),
      makeProfile({
        id: "bad-sharpe",
        paperMetrics: { ...HEALTHY_METRICS, rollingSharpe7d: -1.5 },
      }),
      makeProfile({ id: "inactive", paperTradeCount: 0, paperDaysActive: 30 }),
    ];
    const result = gc.collect(profiles);
    expect(result.killed).toHaveLength(2);
    expect(result.killed).toContain("bad-sharpe");
    expect(result.killed).toContain("inactive");
  });

  it("prioritizes first matching kill rule", () => {
    const profiles = [
      makeProfile({
        paperMetrics: { ...HEALTHY_METRICS, rollingSharpe7d: -2, consecutiveLossDays: 20 },
      }),
    ];
    const result = gc.collect(profiles);
    expect(result.killed).toHaveLength(1);
    // Rule 1 (Sharpe) fires first
    expect(result.reasons.get("strat-1")).toContain("sustained negative");
  });
});
