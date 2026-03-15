import { describe, expect, it, vi } from "vitest";
import { selectPhaseB } from "./policy.js";
import type { EpisodicTriplet, RetrievalCandidate, SelfEvolveConfig } from "./types.js";

function makeTriplet(id: string, qValue: number): EpisodicTriplet {
  return {
    id,
    intent: `intent ${id}`,
    experience: `experience ${id}`,
    embedding: [1, 0, 0],
    qValue,
    visits: 0,
    selectedCount: 0,
    successCount: 0,
    lastReward: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function config(overrides?: {
  retrieval?: Partial<SelfEvolveConfig["retrieval"]>;
}): SelfEvolveConfig {
  return {
    embedding: { provider: "hash", model: "x", dimensions: 64 },
    retrieval: {
      k1: 5,
      k2: 2,
      delta: 0,
      tau: 0,
      lambda: 0.5,
      epsilon: 0,
      ...overrides?.retrieval,
    },
    learning: { alpha: 0.3, gamma: 0, qInit: 0, rewardSuccess: 1, rewardFailure: -1 },
    memory: { maxEntries: 200, maxExperienceChars: 1000, includeFailures: true },
    reward: { provider: "openai", model: "gpt-4.1-mini", temperature: 0 },
    runtime: {
      minPromptChars: 6,
      observeTurns: 0,
      minAbsReward: 0,
      minRewardConfidence: 0,
      learnMode: "balanced",
      noToolMinAbsReward: 0.8,
      noToolMinRewardConfidence: 0.9,
      newIntentSimilarityThreshold: 0.35,
      idleTurnsToClose: 2,
      pendingTtlMs: 900000,
      maxTurnsPerTask: 10,
    },
    experience: {
      summarizer: "openai",
      model: "gpt-4.1-mini",
      temperature: 0,
      maxToolEvents: 6,
      maxRawChars: 1200,
      maxSummaryChars: 500,
    },
  };
}

describe("selectPhaseB", () => {
  it("returns no selection when sim max is below tau", () => {
    const candidates: RetrievalCandidate[] = [
      { triplet: makeTriplet("a", 0.4), similarity: 0.05 },
      { triplet: makeTriplet("b", 0.9), similarity: 0.08 },
    ];
    const result = selectPhaseB({
      candidates,
      config: config({ retrieval: { tau: 0.2 } }),
    });
    expect(result.selected).toHaveLength(0);
    expect(result.simMax).toBe(0.08);
  });

  it("prefers high q candidates when lambda is high", () => {
    const candidates: RetrievalCandidate[] = [
      { triplet: makeTriplet("a", -0.8), similarity: 0.95 },
      { triplet: makeTriplet("b", 0.95), similarity: 0.8 },
      { triplet: makeTriplet("c", 0.6), similarity: 0.75 },
    ];
    const result = selectPhaseB({
      candidates,
      config: config({ retrieval: { lambda: 0.75 } }),
    });
    expect(result.selected.map((item) => item.triplet.id)).toEqual(["b", "c"]);
  });

  it("uses epsilon exploration for random sampling", () => {
    const candidates: RetrievalCandidate[] = [
      { triplet: makeTriplet("a", 0), similarity: 0.95 },
      { triplet: makeTriplet("b", 0), similarity: 0.8 },
      { triplet: makeTriplet("c", 0), similarity: 0.75 },
    ];
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.2);
    const result = selectPhaseB({
      candidates,
      config: config({ retrieval: { epsilon: 1 } }),
      random,
    });
    expect(result.selected).toHaveLength(2);
    expect(new Set(result.selected.map((item) => item.triplet.id)).size).toBe(2);
  });
});
