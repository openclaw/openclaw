import { describe, expect, it } from "vitest";
import { selfEvolveConfigSchema } from "./config.js";

describe("selfEvolveConfigSchema", () => {
  it("provides runtime defaults", () => {
    const parsed = selfEvolveConfigSchema.parse(undefined);
    expect(parsed.runtime.observeTurns).toBe(0);
    expect(parsed.runtime.minAbsReward).toBe(0.15);
    expect(parsed.runtime.minRewardConfidence).toBe(0.55);
    expect(parsed.runtime.learnMode).toBe("balanced");
    expect(parsed.runtime.noToolMinAbsReward).toBe(0.8);
    expect(parsed.runtime.noToolMinRewardConfidence).toBe(0.9);
    expect(parsed.runtime.newIntentSimilarityThreshold).toBe(0.35);
    expect(parsed.runtime.idleTurnsToClose).toBe(2);
    expect(parsed.runtime.pendingTtlMs).toBe(300000);
    expect(parsed.runtime.maxTurnsPerTask).toBe(5);
    expect(parsed.experience.maxToolEvents).toBe(12);
  });

  it("accepts runtime overrides", () => {
    const parsed = selfEvolveConfigSchema.parse({
      runtime: {
        minPromptChars: 10,
        observeTurns: 8,
        minAbsReward: 0.2,
        minRewardConfidence: 0.7,
        learnMode: "tools_only",
        noToolMinAbsReward: 0.85,
        noToolMinRewardConfidence: 0.95,
        newIntentSimilarityThreshold: 0.4,
        idleTurnsToClose: 3,
        pendingTtlMs: 600000,
        maxTurnsPerTask: 7,
      },
      experience: {
        maxToolEvents: 8,
        maxRawChars: 3000,
        maxSummaryChars: 600,
      },
    });
    expect(parsed.runtime.minPromptChars).toBe(10);
    expect(parsed.runtime.observeTurns).toBe(8);
    expect(parsed.runtime.minRewardConfidence).toBe(0.7);
    expect(parsed.runtime.learnMode).toBe("tools_only");
    expect(parsed.runtime.noToolMinAbsReward).toBe(0.85);
    expect(parsed.runtime.noToolMinRewardConfidence).toBe(0.95);
    expect(parsed.runtime.newIntentSimilarityThreshold).toBe(0.4);
    expect(parsed.runtime.idleTurnsToClose).toBe(3);
    expect(parsed.runtime.pendingTtlMs).toBe(600000);
    expect(parsed.runtime.maxTurnsPerTask).toBe(7);
    expect(parsed.experience.maxToolEvents).toBe(8);
  });
});
