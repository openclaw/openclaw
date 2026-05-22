import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProviderLimiterBucketKey,
  estimateProviderRequestTokens,
  observeProviderLimiterResponse,
  parseProviderRateLimitHeaders,
  parseRetryAfterMs,
  reserveProviderLimiterSlot,
  resetProviderLimiterForTests,
  resolveProviderLimiterPolicy,
} from "./provider-rate-limiter.js";

describe("provider rate limiter", () => {
  afterEach(() => {
    resetProviderLimiterForTests();
    vi.useRealTimers();
    delete process.env.OPENCLAW_PROVIDER_LIMITER_HEADROOM;
    delete process.env.OPENCLAW_PROVIDER_LIMITER_MINIMAX_WEEKLY;
  });

  it("selects MiniMax M2.7 and highspeed policies with documented defaults", () => {
    const policy = resolveProviderLimiterPolicy({ provider: "minimax", model: "MiniMax-M2.7" });
    const highspeed = resolveProviderLimiterPolicy({
      provider: "minimax-portal",
      model: "MiniMax-M2.7-highspeed",
    });
    expect(policy).toMatchObject({ rpm: 500, tpm: 20_000_000, headroom: 0.85 });
    expect(policy?.weeklyRequestLimit).toBe(500 * 60 * 5 * 10);
    expect(policy?.weeklyTokenLimit).toBe(20_000_000 * 60 * 5 * 10);
    expect(highspeed?.rpm).toBe(500);
    expect(resolveProviderLimiterPolicy({ provider: "openai", model: "gpt-5.4" })).toBeUndefined();
  });

  it("builds provider/profile/capability/model bucket keys", () => {
    expect(
      buildProviderLimiterBucketKey({
        provider: "MiniMax",
        profile: "acct-A",
        capability: "LLM",
        model: "MiniMax-M2.7",
      }),
    ).toBe("minimax|acct-a|llm|MiniMax-M2.7");
  });

  it("delays when RPM headroom is exhausted", () => {
    const policy = {
      enabled: true,
      provider: "minimax",
      model: "MiniMax-M2.7",
      rpm: 2,
      tpm: 1_000,
      headroom: 0.5,
      weeklyEnabled: false,
    };
    const key = { provider: "minimax", model: "MiniMax-M2.7", capability: "llm" };
    expect(reserveProviderLimiterSlot({ key, policy, tokens: 1, nowMs: 1_000 }).delayMs).toBe(0);
    const second = reserveProviderLimiterSlot({ key, policy, tokens: 1, nowMs: 1_001 });
    expect(second.reason).toBe("rpm");
    expect(second.delayMs).toBe(59_999);
  });

  it("delays when TPM headroom is exhausted", () => {
    const policy = {
      enabled: true,
      provider: "minimax",
      model: "MiniMax-M2.7",
      rpm: 100,
      tpm: 10,
      headroom: 1,
      weeklyEnabled: false,
    };
    const key = { provider: "minimax", model: "MiniMax-M2.7", capability: "llm" };
    expect(reserveProviderLimiterSlot({ key, policy, tokens: 8, nowMs: 2_000 }).delayMs).toBe(0);
    const second = reserveProviderLimiterSlot({ key, policy, tokens: 3, nowMs: 2_500 });
    expect(second.reason).toBe("tpm");
    expect(second.delayMs).toBe(59_500);
  });

  it("accounts for weekly request allowance", () => {
    const policy = {
      enabled: true,
      provider: "minimax",
      model: "MiniMax-M2.7",
      rpm: 100,
      tpm: 1_000,
      headroom: 1,
      weeklyEnabled: true,
      weeklyRequestLimit: 1,
      weeklyTokenLimit: 1_000,
    };
    const key = { provider: "minimax", model: "MiniMax-M2.7", capability: "llm" };
    expect(reserveProviderLimiterSlot({ key, policy, tokens: 1, nowMs: 10_000 }).delayMs).toBe(0);
    const second = reserveProviderLimiterSlot({ key, policy, tokens: 1, nowMs: 11_000 });
    expect(second.reason).toBe("weekly-requests");
    expect(second.delayMs).toBe(7 * 24 * 60 * 60 * 1000 - 1_000);
  });

  it("parses Retry-After seconds and HTTP-date", () => {
    expect(parseRetryAfterMs("2.5", 1_000)).toBe(2_500);
    expect(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:03 GMT", 1_000)).toBe(2_000);
    expect(parseRetryAfterMs("nonsense", 1_000)).toBeUndefined();
  });

  it("parses standard rate-limit headers", () => {
    const headers = new Headers({
      "x-ratelimit-limit": "123",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "5",
      "retry-after": "2",
    });
    expect(parseProviderRateLimitHeaders(headers, 10_000)).toEqual({
      retryAfterMs: 2_000,
      limit: 123,
      remaining: 0,
      resetAtMs: 15_000,
    });
  });

  it("learns Retry-After cooldowns from 429 responses", () => {
    const policy = {
      enabled: true,
      provider: "minimax",
      model: "MiniMax-M2.7",
      rpm: 100,
      tpm: 1_000,
      headroom: 1,
      weeklyEnabled: false,
    };
    const key = { provider: "minimax", model: "MiniMax-M2.7", capability: "llm" };
    observeProviderLimiterResponse({
      key,
      policy,
      status: 429,
      headers: new Headers({ "retry-after": "3" }),
      nowMs: 10_000,
    });
    const next = reserveProviderLimiterSlot({ key, policy, tokens: 1, nowMs: 11_000 });
    expect(next.reason).toBe("retry-after");
    expect(next.delayMs).toBe(2_000);
  });

  it("estimates request tokens conservatively from JSON payloads", () => {
    expect(estimateProviderRequestTokens(JSON.stringify({ input: "abcdefgh" }))).toBeGreaterThan(1);
    expect(estimateProviderRequestTokens(undefined)).toBe(1);
  });
});
