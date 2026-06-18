// Covers provider-specific failover matcher regressions.
import { describe, expect, it } from "vitest";
import { classifyFailoverReason } from "./errors.js";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
} from "./failover-matches.js";

describe("Z.ai vendor error codes (#48988)", () => {
  describe("error 1311 — model not included in subscription plan", () => {
    it("classifies Z.ai 1311 JSON body as billing", () => {
      // Z.ai 1311 is a plan entitlement failure, not rate limiting.
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

describe("Volcengine Coding Plan subscription errors", () => {
  it("classifies InvalidSubscription JSON body as billing", () => {
    const raw =
      '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid CodingPlan subscription, or your subscription has expired."}}';
    expect(isBillingErrorMessage(raw)).toBe(true);
  });

  it("classifies long InvalidSubscription payloads as billing", () => {
    const raw = JSON.stringify({
      error: {
        code: "InvalidSubscription",
        message:
          "Your account does not have a valid coding plan subscription, or your subscription has expired.",
        details: "x".repeat(700),
      },
    });
    expect(raw.length).toBeGreaterThan(512);
    expect(isBillingErrorMessage(raw)).toBe(true);
  });

  it("classifies InvalidSubscription as billing before auth or rate limit", () => {
    const raw =
      '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid CodingPlan subscription, or your subscription has expired."}}';
    expect(isRateLimitErrorMessage(raw)).toBe(false);
    expect(classifyFailoverReason(raw)).toBe("billing");
  });
});

describe("agent harness provider mismatch (#91710)", () => {
  it("classifies harness provider rejection as format error", () => {
    expect(
      classifyFailoverReason(
        'Requested agent harness "codex" does not support openai/gpt-5.3-codex (provider is not one of: codex).',
      ),
    ).toBe("format");
  });

  it("classifies harness provider rejection with multiple providers as format error", () => {
    expect(
      classifyFailoverReason(
        'Requested agent harness "codex" does not support openrouter/gpt-5.4 (provider is not one of: codex, openai).',
      ),
    ).toBe("format");
  });
});

describe("server error status classification", () => {
  it("classifies a bare internal server error status as server error", () => {
    // Bare status lines from providers should classify, while prefixed prose is
    // too ambiguous and tested below as a non-match.
    expect(isServerErrorMessage("status: internal server error")).toBe(true);
  });

  it("classifies provider HTTP 5xx wrapper errors as server errors", () => {
    expect(isServerErrorMessage("provider failed (HTTP 500): upstream apiKey is empty")).toBe(true);
  });

  it("does not classify prefixed plain internal server error status prose", () => {
    expect(isServerErrorMessage("Proxy notice: Status: Internal Server Error")).toBe(false);
  });
});

// [2026-06-18 PR] Content policy / new_sensitive moderation errors should trigger
// failover by classifying as rate_limit. Without this, agent sessions fail hard
// the first time a long-running batch hits provider-side content moderation.
describe("content policy / new_sensitive fallback classification", () => {
  it("classifies MiniMax new_sensitive (1027) as rate_limit", () => {
    expect(
      classifyFailoverReason("output new_sensitive (1027)", { provider: "minimax-portal" }),
    ).toBe("rate_limit");
  });

  it("classifies Anthropic content_filter as rate_limit", () => {
    expect(
      classifyFailoverReason("content_filter triggered on prompt", { provider: "anthropic" }),
    ).toBe("rate_limit");
  });

  it("classifies Anthropic safety_block as rate_limit", () => {
    expect(
      classifyFailoverReason("safety_block activated", { provider: "anthropic" }),
    ).toBe("rate_limit");
  });

  it("classifies OpenAI content_policy_violation as rate_limit", () => {
    expect(
      classifyFailoverReason("content_policy_violation: prompt rejected", { provider: "openai" }),
    ).toBe("rate_limit");
  });

  it("matches case-insensitively across providers", () => {
    expect(
      classifyFailoverReason("Output NEW_SENSITIVE (1027)", { provider: "minimax-portal" }),
    ).toBe("rate_limit");
    expect(
      classifyFailoverReason("CONTENT_FILTER", { provider: "anthropic" }),
    ).toBe("rate_limit");
  });

  it("does not misclassify unrelated rate-limit-looking errors", () => {
    // Plain 429 / quota text should still go through the normal rate_limit path
    // and not be confused with content policy errors.
    expect(
      classifyFailoverReason("Too Many Requests (HTTP 429)"),
    ).toBe("rate_limit");
  });
});
