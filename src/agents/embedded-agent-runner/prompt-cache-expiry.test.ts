import { resolveOpenAIPromptCacheParams } from "@openclaw/ai/internal/openai";
import { resolveOpenAICompletionsCompat } from "@openclaw/ai/transports";
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
const codex: Model = {
  ...openai,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
};
const observation = { authMode: "api-key", usage: { cacheRead: 2000 }, requestStartedAt: now, now };

describe("cache-expiry qualification", () => {
  it.each([
    [anthropic, "long", 3_600_000],
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
    { model: anthropic, retention: "short" },
    { model: { ...anthropic, compat: { supportsLongCacheRetention: false } }, retention: "long" },
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
    { model: { ...codex, provider: "custom-codex" }, authMode: "oauth" },
    { model: { ...codex, baseUrl: "https://proxy.example/backend-api/codex" }, authMode: "oauth" },
    { model: { ...codex, baseUrl: "https://chatgpt.com/unrelated" }, authMode: "oauth" },
    { model: { ...codex, baseUrl: "http://chatgpt.com/backend-api/codex" }, authMode: "oauth" },
    {
      model: { ...codex, baseUrl: "https://chatgpt.com:8443/backend-api/codex" },
      authMode: "oauth",
    },
    { model: { ...codex, api: "openai-responses" }, authMode: "oauth" },
    { model: codex, authMode: "oauth", retention: "none" },
    { model: codex, authMode: "oauth", usage: { input: 2000 } },
    { model: anthropic, authMode: "oauth" },
    { model: anthropic, authMode: undefined },
    { model: anthropic, retention: "none" },
    { model: anthropic, usage: { cacheRead: 0, cacheWrite: 0 } },
    { model: anthropic, usage: { input: 2000 } },
    { model: anthropic, usage: { cacheRead: 2000, cacheTelemetry: { state: "unavailable" } } },
    { model: anthropic, requestStartedAt: now + 1 },
    { model: anthropic, requestStartedAt: undefined },
  ] satisfies Array<Partial<Parameters<typeof estimatePromptCacheExpiry>[0]> & { model: Model }>)(
    "does not qualify automatic compaction: %j",
    (overrides) => {
      expect(
        estimatePromptCacheExpiry({ ...observation, retention: "long", ...overrides }),
      ).toBeUndefined();
    },
  );

  it.each([
    { retention: "long", promptCacheTtl: "12h", wireTtl: "12h", windowMs: 43_200_000 },
    { retention: "short", promptCacheTtl: "12h", wireTtl: "12h", windowMs: 43_200_000 },
    { retention: "long", promptCacheTtl: "30m", wireTtl: "30m", windowMs: 1_800_000 },
    { retention: "none", promptCacheTtl: "12h", wireTtl: undefined, windowMs: undefined },
    { retention: "long", promptCacheTtl: undefined, wireTtl: "30m", windowMs: 1_800_000 },
    { retention: "short", promptCacheTtl: undefined, wireTtl: undefined, windowMs: 1_800_000 },
    {
      retention: "short",
      promptCacheTtl: "12h",
      compat: { supportsLongCacheRetention: false },
      wireTtl: undefined,
      windowMs: 1_800_000,
    },
    {
      retention: "long",
      promptCacheTtl: "12h",
      compat: { supportsPromptCacheKey: false },
      wireTtl: undefined,
      windowMs: undefined,
    },
  ] as const)("follows the actual API lifetime policy: %j", (scenario) => {
    const model = { ...openai, ...("compat" in scenario ? { compat: scenario.compat } : {}) };
    const policy = resolveOpenAIPromptCacheParams(
      model,
      scenario.retention,
      resolveOpenAICompletionsCompat(model),
      scenario.promptCacheTtl,
    );
    expect(policy.prompt_cache_options?.ttl).toBe(scenario.wireTtl);
    const estimate = estimatePromptCacheExpiry({ ...observation, model, ...scenario });
    expect(estimate?.windowMs).toBe(scenario.windowMs);
    if (estimate && scenario.windowMs !== undefined) {
      expect(planCacheExpiryCompaction(estimate, now)).toEqual({
        notBefore: now + scenario.windowMs - 300_000,
        expiresAt: now + scenario.windowMs,
      });
    }
  });

  it("does not project Responses-only TTLs onto Completions, OAuth, or custom endpoints", () => {
    const lifetime = { promptCacheTtl: "12h" } as const;
    expect(
      estimatePromptCacheExpiry({
        ...observation,
        ...lifetime,
        model: { ...openai, api: "openai-completions" },
      })?.windowMs,
    ).toBe(1_800_000);
    expect(
      estimatePromptCacheExpiry({ ...observation, ...lifetime, model: codex, authMode: "oauth" }),
    ).toEqual({ observedAt: now, windowMs: 1_800_000, basis: "codex-idle-heuristic" });
    expect(
      estimatePromptCacheExpiry({
        ...observation,
        ...lifetime,
        model: {
          ...openai,
          baseUrl: "https://proxy.example/v1",
          compat: { supportsPromptCacheKey: true, supportsLongCacheRetention: true },
        },
      }),
    ).toBeUndefined();
  });

  it("labels the subscription idle assumption separately from provider lifetime facts", () => {
    expect(
      estimatePromptCacheExpiry({
        ...observation,
        model: codex,
        authMode: "oauth",
        requestStartedAt: now - 120_000,
      }),
    ).toEqual({ observedAt: now, windowMs: 1_800_000, basis: "codex-idle-heuristic" });
  });

  it.each([
    [60_000, undefined],
    [300_000, undefined],
    [1_800_000, now + 1_500_000],
    [3_600_000, now + 3_300_000],
  ] as const)("leaves five minutes for an eligible %i ms window", (windowMs, notBefore) => {
    const plan = planCacheExpiryCompaction(
      { observedAt: now, windowMs, basis: "anthropic-ttl" },
      now,
    );
    expect(plan).toEqual(
      notBefore === undefined ? undefined : { notBefore, expiresAt: now + windowMs },
    );
  });

  it("counts generation time, permits cache writes, and never schedules an expired observation", () => {
    const estimate = estimatePromptCacheExpiry({
      ...observation,
      model: anthropic,
      retention: "long",
      usage: { cacheWrite: 1500 },
      requestStartedAt: now - 3_480_000,
    });
    expect(estimate).toBeDefined();
    if (!estimate) {
      throw new Error("expected a qualified observation");
    }
    expect(planCacheExpiryCompaction(estimate, now)).toEqual({
      notBefore: now,
      expiresAt: now + 120_000,
    });
    expect(planCacheExpiryCompaction(estimate, now + 120_000)).toBeUndefined();
    expect(
      planCacheExpiryCompaction(
        { ...estimate, observedAt: now - 240_000, windowMs: 1_800_000 },
        now,
      ),
    ).toEqual({
      notBefore: now + 1_260_000,
      expiresAt: now + 1_560_000,
    });
  });
});
