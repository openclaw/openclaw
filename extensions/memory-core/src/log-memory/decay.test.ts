import { describe, expect, it } from "vitest";
import { computeCurrentDecay, computeInitialDecay } from "./decay.js";
import type { LogMemoryEntry } from "./types.js";

function entry(overrides: Partial<LogMemoryEntry> & { timestamp: Date }): LogMemoryEntry {
  return {
    id: "x",
    timestamp: overrides.timestamp,
    layer: overrides.layer ?? "episodic",
    embedding: overrides.embedding,
    payload: {
      type: "raw_log",
      content: "c",
      tags: [],
      source: "log_ingest",
      decayScore: 1,
      accessCount: 0,
      lastAccessedAt: overrides.timestamp,
      ...overrides.payload,
    },
  };
}

describe("computeInitialDecay", () => {
  it("boosts ERROR but caps at 1.0", () => {
    expect(computeInitialDecay("ERROR")).toBe(1.0);
    expect(computeInitialDecay("WARN")).toBe(1.0);
    expect(computeInitialDecay("INFO")).toBe(1.0);
  });
});

describe("computeCurrentDecay", () => {
  it("decays with age", () => {
    const now = new Date("2026-05-07T00:00:00Z");
    const fresh = entry({ timestamp: now });
    const old = entry({ timestamp: new Date(now.getTime() - 200 * 3_600_000) });
    expect(computeCurrentDecay(fresh, now)).toBeGreaterThan(computeCurrentDecay(old, now));
  });

  it("boosts engineer_knowledge above raw_log", () => {
    const now = new Date("2026-05-07T00:00:00Z");
    // Pick an age large enough that recencyFactor * importance is below the
    // [0,1] clamp ceiling so the importance multiplier is observable.
    const ts = new Date(now.getTime() - 24 * 3_600_000);
    const log = entry({ timestamp: ts, payload: { type: "raw_log" } as never });
    const knowledge = entry({
      timestamp: ts,
      payload: { type: "engineer_knowledge" } as never,
    });
    expect(computeCurrentDecay(knowledge, now)).toBeGreaterThan(computeCurrentDecay(log, now));
  });

  it("clamps to [0, 1]", () => {
    const now = new Date("2026-05-07T00:00:00Z");
    const veryOld = entry({ timestamp: new Date(now.getTime() - 10_000 * 3_600_000) });
    expect(computeCurrentDecay(veryOld, now)).toBeGreaterThanOrEqual(0);

    const accessed = entry({
      timestamp: now,
      payload: { type: "engineer_knowledge", accessCount: 100 } as never,
    });
    expect(computeCurrentDecay(accessed, now)).toBeLessThanOrEqual(1);
  });
});
