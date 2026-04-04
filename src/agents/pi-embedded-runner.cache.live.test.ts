import type { AssistantMessage } from "@mariozechner/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildStableCachePrefix,
  completeSimpleWithLiveTimeout,
  computeCacheHitRate,
  extractAssistantText,
  LIVE_CACHE_TEST_ENABLED,
  logLiveCache,
  resolveLiveDirectModel,
} from "./live-cache-test-support.js";

const describeCacheLive = LIVE_CACHE_TEST_ENABLED ? describe : describe.skip;

const OPENAI_TIMEOUT_MS = 120_000;
const ANTHROPIC_TIMEOUT_MS = 120_000;
const OPENAI_SESSION_ID = "live-cache-openai-stable-session";
const ANTHROPIC_SESSION_ID = "live-cache-anthropic-stable-session";
const OPENAI_PREFIX = buildStableCachePrefix("openai");
const ANTHROPIC_PREFIX = buildStableCachePrefix("anthropic");

type CacheRun = {
  hitRate: number;
  suffix: string;
  text: string;
  usage: AssistantMessage["usage"];
};

async function runOpenAiCacheProbe(params: {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
  suffix: string;
}): Promise<CacheRun> {
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: OPENAI_PREFIX,
      messages: [
        {
          role: "user",
          content: `Reply with exactly CACHE-OK ${params.suffix}.`,
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: "short",
      sessionId: params.sessionId,
      maxTokens: 32,
      temperature: 0,
      reasoning: "none",
    },
    `openai cache probe ${params.suffix}`,
    OPENAI_TIMEOUT_MS,
  );
  const text = extractAssistantText(response);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  return {
    suffix: params.suffix,
    text,
    usage: response.usage,
    hitRate: computeCacheHitRate(response.usage),
  };
}

async function runAnthropicCacheProbe(params: {
  apiKey: string;
  model: Awaited<ReturnType<typeof resolveLiveDirectModel>>["model"];
  sessionId: string;
  suffix: string;
  cacheRetention: "none" | "short" | "long";
}): Promise<CacheRun> {
  const response = await completeSimpleWithLiveTimeout(
    params.model,
    {
      systemPrompt: ANTHROPIC_PREFIX,
      messages: [
        {
          role: "user",
          content: `Reply with exactly CACHE-OK ${params.suffix}.`,
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: params.apiKey,
      cacheRetention: params.cacheRetention,
      sessionId: params.sessionId,
      maxTokens: 32,
      temperature: 0,
    },
    `anthropic cache probe ${params.suffix} (${params.cacheRetention})`,
    ANTHROPIC_TIMEOUT_MS,
  );
  const text = extractAssistantText(response);
  expect(text.toLowerCase()).toContain(params.suffix.toLowerCase());
  return {
    suffix: params.suffix,
    text,
    usage: response.usage,
    hitRate: computeCacheHitRate(response.usage),
  };
}

describeCacheLive("pi embedded runner prompt caching (live)", () => {
  describe("openai", () => {
    let fixture: Awaited<ReturnType<typeof resolveLiveDirectModel>>;

    beforeAll(async () => {
      fixture = await resolveLiveDirectModel({
        provider: "openai",
        api: "openai-responses",
        envVar: "OPENCLAW_LIVE_OPENAI_CACHE_MODEL",
        preferredModelIds: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.2"],
      });
      logLiveCache(`openai model=${fixture.model.provider}/${fixture.model.id}`);
    }, 120_000);

    it(
      "hits a high cache-read rate on repeated stable prefixes",
      async () => {
        const warmup = await runOpenAiCacheProbe({
          ...fixture,
          sessionId: OPENAI_SESSION_ID,
          suffix: "warmup",
        });
        logLiveCache(
          `openai warmup cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );

        const hitRuns = [
          await runOpenAiCacheProbe({
            ...fixture,
            sessionId: OPENAI_SESSION_ID,
            suffix: "hit-a",
          }),
          await runOpenAiCacheProbe({
            ...fixture,
            sessionId: OPENAI_SESSION_ID,
            suffix: "hit-b",
          }),
        ];

        const bestHit = hitRuns.reduce((best, candidate) =>
          (candidate.usage.cacheRead ?? 0) > (best.usage.cacheRead ?? 0) ? candidate : best,
        );
        logLiveCache(
          `openai best-hit suffix=${bestHit.suffix} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.7);
      },
      6 * 60_000,
    );
  });

  describe("anthropic", () => {
    let fixture: Awaited<ReturnType<typeof resolveLiveDirectModel>>;

    beforeAll(async () => {
      fixture = await resolveLiveDirectModel({
        provider: "anthropic",
        api: "anthropic-messages",
        envVar: "OPENCLAW_LIVE_ANTHROPIC_CACHE_MODEL",
        preferredModelIds: ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-3-5"],
      });
      logLiveCache(`anthropic model=${fixture.model.provider}/${fixture.model.id}`);
    }, 120_000);

    it(
      "writes cache on warmup and reads it back on repeated stable prefixes",
      async () => {
        const warmup = await runAnthropicCacheProbe({
          ...fixture,
          sessionId: ANTHROPIC_SESSION_ID,
          suffix: "warmup",
          cacheRetention: "short",
        });
        logLiveCache(
          `anthropic warmup cacheWrite=${warmup.usage.cacheWrite} cacheRead=${warmup.usage.cacheRead} input=${warmup.usage.input} rate=${warmup.hitRate.toFixed(3)}`,
        );
        expect(warmup.usage.cacheWrite ?? 0).toBeGreaterThan(0);

        const hitRuns = [
          await runAnthropicCacheProbe({
            ...fixture,
            sessionId: ANTHROPIC_SESSION_ID,
            suffix: "hit-a",
            cacheRetention: "short",
          }),
          await runAnthropicCacheProbe({
            ...fixture,
            sessionId: ANTHROPIC_SESSION_ID,
            suffix: "hit-b",
            cacheRetention: "short",
          }),
        ];

        const bestHit = hitRuns.reduce((best, candidate) =>
          (candidate.usage.cacheRead ?? 0) > (best.usage.cacheRead ?? 0) ? candidate : best,
        );
        logLiveCache(
          `anthropic best-hit suffix=${bestHit.suffix} cacheWrite=${bestHit.usage.cacheWrite} cacheRead=${bestHit.usage.cacheRead} input=${bestHit.usage.input} rate=${bestHit.hitRate.toFixed(3)}`,
        );

        expect(bestHit.usage.cacheRead ?? 0).toBeGreaterThan(1_024);
        expect(bestHit.hitRate).toBeGreaterThanOrEqual(0.7);
      },
      6 * 60_000,
    );

    it(
      "does not report meaningful cache activity when retention is disabled",
      async () => {
        const disabled = await runAnthropicCacheProbe({
          ...fixture,
          sessionId: `${ANTHROPIC_SESSION_ID}-disabled`,
          suffix: "no-cache",
          cacheRetention: "none",
        });
        logLiveCache(
          `anthropic none cacheWrite=${disabled.usage.cacheWrite} cacheRead=${disabled.usage.cacheRead} input=${disabled.usage.input}`,
        );

        expect(disabled.usage.cacheRead ?? 0).toBeLessThanOrEqual(32);
        expect(disabled.usage.cacheWrite ?? 0).toBeLessThanOrEqual(32);
      },
      3 * 60_000,
    );
  });
});
