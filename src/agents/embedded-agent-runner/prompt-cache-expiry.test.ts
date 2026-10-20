import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { planCacheExpiryCompaction } from "../session-maintenance/cache-expiry.js";
import { estimatePromptCacheExpiry } from "./prompt-cache-expiry.js";

const now = 1_700_000_000_000;
const anthropic: Model = {
  id: "claude-sonnet-4-6",
  name: "Fixture",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const openai: Model = {
  ...anthropic,
  id: "gpt-5.6",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};
const observation = { authMode: "api-key", usage: { cacheRead: 2000 }, requestStartedAt: now, now };

describe("cache-expiry qualification", () => {
  it.each([
    [anthropic, "short", 300_000],
    [anthropic, "long", 3_600_000],
    [{ ...anthropic, compat: { supportsLongCacheRetention: false } }, "long", 300_000],
    [openai, undefined, 1_800_000],
    [openai, "short", 1_800_000],
    [openai, "long", 1_800_000],
  ] as const)("uses effective route policy for %j/%s", (model, retention, windowMs) => {
    expect(estimatePromptCacheExpiry({ ...observation, model, retention })).toMatchObject({
      observedAt: now,
      windowMs,
    });
  });

  it.each([
    { model: { ...anthropic, baseUrl: "https://proxy.example" }, retention: "long" },
    { model: { ...openai, baseUrl: "https://proxy.example" }, retention: "long" },
    { model: { ...openai, id: "gpt-5.4" }, retention: "long" },
    { model: { ...openai, baseUrl: "" } },
    {
      model: {
        ...openai,
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    },
    { model: anthropic, authMode: "oauth" },
    { model: anthropic, authMode: undefined },
    { model: anthropic, retention: "none" },
    { model: anthropic, usage: { cacheRead: 0, cacheWrite: 0 } },
    { model: anthropic, usage: { input: 2000 } },
    { model: anthropic, usage: { cacheRead: 2000, cacheTelemetry: { state: "unavailable" } } },
    { model: anthropic, requestStartedAt: now + 1 },
    { model: anthropic, requestStartedAt: undefined },
  ] satisfies Array<Partial<Parameters<typeof estimatePromptCacheExpiry>[0]> & { model: Model }>)(
    "does not invent a lifetime: %j",
    (overrides) => {
      expect(estimatePromptCacheExpiry({ ...observation, ...overrides })).toBeUndefined();
    },
  );

  it("counts generation time, permits cache writes, and never schedules an expired observation", () => {
    const estimate = estimatePromptCacheExpiry({
      ...observation,
      model: anthropic,
      usage: { cacheWrite: 1500 },
      requestStartedAt: now - 240_000,
    });
    expect(estimate).toBeDefined();
    if (!estimate) {
      throw new Error("expected a qualified observation");
    }
    expect(planCacheExpiryCompaction(estimate, now)).toEqual({
      notBefore: now + 30_000,
      expiresAt: now + 60_000,
    });
    expect(planCacheExpiryCompaction(estimate, now + 60_000)).toBeUndefined();
    expect(planCacheExpiryCompaction({ ...estimate, windowMs: 1_800_000 }, now)).toEqual({
      notBefore: now + 1_500_000,
      expiresAt: now + 1_560_000,
    });
  });
});
