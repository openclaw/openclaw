import { describe, expect, it } from "vitest";
import { calibrateRewardResult, RewardScorer } from "./reward.js";
import type { SelfEvolveConfig } from "./types.js";

function config(overrides?: Partial<SelfEvolveConfig["reward"]>): SelfEvolveConfig {
  return {
    embedding: { provider: "hash", model: "x", dimensions: 64 },
    retrieval: { k1: 5, k2: 2, delta: 0, tau: 0, lambda: 0.5, epsilon: 0 },
    learning: { alpha: 0.3, gamma: 0, qInit: 0, rewardSuccess: 1, rewardFailure: -1 },
    memory: { maxEntries: 300, maxExperienceChars: 1000, includeFailures: true },
    reward: {
      provider: "openai",
      model: "gpt-4.1-mini",
      temperature: 0,
      ...overrides,
    },
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

describe("RewardScorer", () => {
  it("returns unavailable when no reward model client is configured", async () => {
    const scorer = new RewardScorer(config());
    const result = await scorer.score({
      userFeedback: "works now",
      intent: "fix issue",
      assistantResponse: "run command",
    });
    expect(result.source).toBe("unavailable");
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("returns unavailable for blank feedback", async () => {
    const scorer = new RewardScorer(config());
    const result = await scorer.score({
      userFeedback: "   ",
      intent: "fix issue",
      assistantResponse: "run command",
    });
    expect(result.source).toBe("unavailable");
    expect(result.score).toBe(0);
  });

  it("calibrates implicit negative feedback with tool failures", () => {
    const result = calibrateRewardResult(
      { score: -0.1, confidence: 0.4, source: "openai" },
      {
        userFeedback: "这个有问题，换个方法试试",
        intent: "fix issue",
        assistantResponse: "run command",
        toolSignals: { toolCalls: 2, toolFailures: 1, toolSuccessRate: 0.5, hasToolError: true },
      },
    );
    expect(result.score).toBeLessThanOrEqual(-0.7);
    expect(result.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("calibrates positive feedback when tool success is consistent", () => {
    const result = calibrateRewardResult(
      { score: 0.35, confidence: 0.5, source: "openai" },
      {
        userFeedback: "很好，已经解决了，谢谢",
        intent: "fix issue",
        assistantResponse: "run command",
        toolSignals: { toolCalls: 3, toolFailures: 0, toolSuccessRate: 1, hasToolError: false },
      },
    );
    expect(result.score).toBeGreaterThanOrEqual(0.6);
    expect(result.confidence).toBeGreaterThanOrEqual(0.72);
  });

  it("dampens likely new request to near-zero when no feedback signal", () => {
    const result = calibrateRewardResult(
      { score: 0.5, confidence: 0.8, source: "openai" },
      {
        userFeedback: "可以帮我再看下 /tmp 目录吗？",
        intent: "fix issue",
        assistantResponse: "run command",
      },
    );
    expect(Math.abs(result.score)).toBeLessThanOrEqual(0.1);
    expect(result.confidence).toBeLessThanOrEqual(0.45);
  });

  it("does not treat toolCalls=0 as successful tool signal for positive boost", () => {
    const result = calibrateRewardResult(
      { score: 0.35, confidence: 0.5, source: "openai" },
      {
        userFeedback: "很好，已经解决了，谢谢",
        intent: "fix issue",
        assistantResponse: "run command",
        toolSignals: { toolCalls: 0, toolFailures: 0, toolSuccessRate: 1, hasToolError: false },
      },
    );
    expect(result.score).toBe(0.35);
    expect(result.confidence).toBe(0.5);
  });
});
