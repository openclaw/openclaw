import { describe, expect, it } from "vitest";
import { IntentJudge } from "./intent.js";
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

describe("IntentJudge", () => {
  it("filters short acknowledgement by rule precheck", async () => {
    const judge = new IntentJudge(config());
    const result = await judge.judge("很好");
    expect(result.isMeaningful).toBe(false);
    expect(result.source).toBe("rule");
    expect(result.reason).toBe("short-acknowledgement");
  });

  it("filters symbol-only input by rule precheck", async () => {
    const judge = new IntentJudge(config());
    const result = await judge.judge("👍👍");
    expect(result.isMeaningful).toBe(false);
    expect(result.source).toBe("rule");
    expect(result.reason).toBe("symbols-or-emoji-only");
  });

  it("returns unavailable when llm check is required but client is not configured", async () => {
    const judge = new IntentJudge(config());
    const result = await judge.judge("请帮我看看/home目录下有哪些文件");
    expect(result.isMeaningful).toBe(false);
    expect(result.source).toBe("unavailable");
    expect(result.reason).toBe("openai-client-unavailable");
  });
});
