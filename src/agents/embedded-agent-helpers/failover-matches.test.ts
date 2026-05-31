import { describe, expect, it } from "vitest";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isPeriodicUsageLimitErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
} from "./failover-matches.js";

describe("isPeriodicUsageLimitErrorMessage", () => {
  it("matches English weekly/monthly limit messages", () => {
    expect(isPeriodicUsageLimitErrorMessage("weekly usage limit exceeded")).toBe(true);
    expect(isPeriodicUsageLimitErrorMessage("monthly limit reached")).toBe(true);
    expect(isPeriodicUsageLimitErrorMessage("daily/weekly/monthly limits exhausted")).toBe(true);
  });

  it("matches Z.ai Chinese weekly/monthly quota message (error 1310)", () => {
    // Real message from gateway logs: "429 您已达到每周/每月使用上限，您的限额将在 2026-05-31 10:00:31 重置。"
    expect(
      isPeriodicUsageLimitErrorMessage(
        "429 您已达到每周/每月使用上限，您的限额将在 2026-05-31 10:00:31 重置。",
      ),
    ).toBe(true);
    expect(isPeriodicUsageLimitErrorMessage("每月使用上限已达到")).toBe(true);
    expect(isPeriodicUsageLimitErrorMessage("每周使用上限")).toBe(true);
  });

  it("matches Codex subscription usage limit message", () => {
    // From openai-codex-responses.ts: "You have hit your ChatGPT usage limit (free plan)."
    expect(
      isPeriodicUsageLimitErrorMessage("You have hit your ChatGPT usage limit (free plan)."),
    ).toBe(true);
    expect(
      isPeriodicUsageLimitErrorMessage("You have hit your usage limit. Try again in ~30 min."),
    ).toBe(true);
  });

  it("does not match transient rate limit or billing errors", () => {
    expect(isPeriodicUsageLimitErrorMessage("Rate limit exceeded, please retry")).toBe(false);
    expect(isPeriodicUsageLimitErrorMessage("Your payment method was declined")).toBe(false);
    expect(isPeriodicUsageLimitErrorMessage("API key is invalid")).toBe(false);
  });
});

describe("Z.ai vendor error codes (#48988)", () => {
  describe("error 1311 — model not included in subscription plan", () => {
    it("classifies Z.ai 1311 JSON body as billing", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("classifies prose-only subscription plan access denials as billing", () => {
      const raw =
        "FailoverError: Your current subscription plan does not yet include access to GLM-5V-Turbo";
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("classifies Z.ai 1311 with spaces as billing", () => {
      const raw = '{"code": 1311, "message": "model not on plan"}';
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("does not misclassify 1311 as rate_limit", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isRateLimitErrorMessage(raw)).toBe(false);
    });

    it("does not misclassify 1311 as auth", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isAuthErrorMessage(raw)).toBe(false);
    });

    it("classifies long Z.ai 1311 payloads as billing", () => {
      const raw = JSON.stringify({
        code: 1311,
        message: "The model you requested is not available in your current plan",
        details: "x".repeat(700),
      });
      expect(raw.length).toBeGreaterThan(512);
      expect(isBillingErrorMessage(raw)).toBe(true);
    });
  });

  describe("error 1113 — wrong endpoint or invalid credentials", () => {
    it("classifies Z.ai 1113 JSON body as auth", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isAuthErrorMessage(raw)).toBe(true);
    });

    it("classifies Z.ai 1113 with spaces as auth", () => {
      const raw = '{"code": 1113, "message": "invalid api endpoint or credentials"}';
      expect(isAuthErrorMessage(raw)).toBe(true);
    });

    it("does not misclassify 1113 as rate_limit", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isRateLimitErrorMessage(raw)).toBe(false);
    });

    it("does not misclassify 1113 as billing", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isBillingErrorMessage(raw)).toBe(false);
    });
  });

  describe("existing patterns are unaffected", () => {
    it("rate limit still classified correctly", () => {
      expect(isRateLimitErrorMessage("rate limit exceeded")).toBe(true);
    });

    it("OpenAI model-capacity text is classified as overloaded", () => {
      expect(
        isOverloadedErrorMessage("Selected model is at capacity. Please try a different model."),
      ).toBe(true);
    });

    it("OpenRouter high-load text is classified as overloaded", () => {
      expect(
        isOverloadedErrorMessage(
          "The service is currently experiencing high load and cannot process your request.",
        ),
      ).toBe(true);
    });

    it("billing still classified correctly", () => {
      expect(isBillingErrorMessage("insufficient credits")).toBe(true);
    });

    it("auth still classified correctly", () => {
      expect(isAuthErrorMessage("invalid api key provided")).toBe(true);
    });
  });
});

describe("server error status classification", () => {
  it("classifies a bare internal server error status as server error", () => {
    expect(isServerErrorMessage("status: internal server error")).toBe(true);
  });

  it("classifies provider HTTP 5xx wrapper errors as server errors", () => {
    expect(isServerErrorMessage("provider failed (HTTP 500): upstream apiKey is empty")).toBe(true);
  });

  it("does not classify prefixed plain internal server error status prose", () => {
    expect(isServerErrorMessage("Proxy notice: Status: Internal Server Error")).toBe(false);
  });
});
