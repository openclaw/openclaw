import { describe, expect, it } from "vitest";
import {
  decideRateLimitAction,
  extractRateLimitInfo,
  extractRetryAfterFromHeaders,
  isRateLimitError,
  parseRetryAfter,
  type RateLimitConfig,
  type RateLimitInfo,
} from "./rate-limit-handler.js";

describe("parseRetryAfter", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfter("60")).toBe(60);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("300")).toBe(300);
  });

  it("returns undefined for invalid values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("invalid")).toBeUndefined();
    expect(parseRetryAfter("-1")).toBeUndefined();
  });

  it("parses HTTP-date format", () => {
    const futureDate = new Date(Date.now() + 30000).toUTCString();
    const result = parseRetryAfter(futureDate);
    expect(result).toBeGreaterThanOrEqual(29);
    expect(result).toBeLessThanOrEqual(31);
  });

  it("returns 0 for past dates", () => {
    const pastDate = new Date(Date.now() - 30000).toUTCString();
    expect(parseRetryAfter(pastDate)).toBe(0);
  });
});

describe("extractRetryAfterFromHeaders", () => {
  it("extracts standard Retry-After header", () => {
    expect(extractRetryAfterFromHeaders({ "Retry-After": "60" })).toBe(60);
    expect(extractRetryAfterFromHeaders({ "retry-after": "30" })).toBe(30);
  });

  it("extracts from Headers object", () => {
    const headers = new Headers();
    headers.set("Retry-After", "45");
    expect(extractRetryAfterFromHeaders(headers)).toBe(45);
  });

  it("extracts OpenAI x-ratelimit-reset headers", () => {
    expect(extractRetryAfterFromHeaders({ "x-ratelimit-reset-tokens": "30s" })).toBe(30);
    expect(extractRetryAfterFromHeaders({ "x-ratelimit-reset-requests": "1m30s" })).toBe(90);
    expect(extractRetryAfterFromHeaders({ "x-ratelimit-reset-tokens": "2m0s" })).toBe(120);
  });

  it("extracts Anthropic ratelimit reset headers", () => {
    const futureTime = new Date(Date.now() + 60000).toISOString();
    const result = extractRetryAfterFromHeaders({
      "anthropic-ratelimit-tokens-reset": futureTime,
    });
    expect(result).toBeGreaterThanOrEqual(59);
    expect(result).toBeLessThanOrEqual(61);
  });

  it("returns undefined for missing headers", () => {
    expect(extractRetryAfterFromHeaders(undefined)).toBeUndefined();
    expect(extractRetryAfterFromHeaders({})).toBeUndefined();
  });

  it("handles array header values", () => {
    expect(extractRetryAfterFromHeaders({ "Retry-After": ["60", "30"] })).toBe(60);
  });
});

describe("isRateLimitError", () => {
  it("detects 429 status", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ statusCode: 429 })).toBe(true);
  });

  it("detects 402 billing status", () => {
    expect(isRateLimitError({ status: 402 })).toBe(true);
  });

  it("detects high-confidence rate limit messages without status", () => {
    // These patterns are specific enough to be trusted without status code
    expect(isRateLimitError({ message: "Rate limit exceeded" })).toBe(true);
    expect(isRateLimitError({ message: "Too many requests" })).toBe(true);
    expect(isRateLimitError({ message: "Quota exceeded for this month" })).toBe(true);
  });

  it("detects billing messages only with relevant status code", () => {
    // With status code - should detect
    expect(isRateLimitError({ status: 402, message: "Billing error: insufficient credits" })).toBe(
      true,
    );
    expect(isRateLimitError({ status: 402, message: "Credit exhausted" })).toBe(true);

    // Without status code (SDK errors) - should detect since status is undefined
    expect(isRateLimitError({ message: "Billing error: insufficient credits" })).toBe(true);
    expect(isRateLimitError({ message: "Credit exhausted" })).toBe(true);

    // With unrelated status code (e.g., 400) - should NOT detect
    // This prevents misclassifying "billing address validation failed" type errors
    expect(isRateLimitError({ status: 400, message: "billing address invalid" })).toBe(false);
    expect(isRateLimitError({ status: 404, message: "credit card not found" })).toBe(false);
  });

  it("detects billing messages with 5xx status (service error mentioning billing)", () => {
    expect(isRateLimitError({ status: 500, message: "billing service unavailable" })).toBe(true);
    expect(isRateLimitError({ status: 503, message: "credit check failed" })).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isRateLimitError({ status: 500 })).toBe(false);
    expect(isRateLimitError({ message: "Internal server error" })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError("string error")).toBe(false);
  });

  it("returns false for unrelated errors mentioning billing/credit keywords", () => {
    // These should NOT be detected as rate limit errors
    expect(isRateLimitError({ status: 400, message: "Invalid billing address" })).toBe(false);
    expect(isRateLimitError({ status: 422, message: "Credit card number invalid" })).toBe(false);
  });
});

describe("extractRateLimitInfo", () => {
  it("extracts info from rate limit error", () => {
    const err = {
      status: 429,
      message: "Rate limit exceeded",
      headers: { "Retry-After": "60" },
    };
    const info = extractRateLimitInfo(err, { provider: "anthropic", model: "claude-3" });
    expect(info).toEqual({
      retryAfterSeconds: 60,
      reason: "rate_limit",
      provider: "anthropic",
      model: "claude-3",
      status: 429,
    });
  });

  it("detects billing errors", () => {
    const err = { status: 402, message: "Payment required" };
    const info = extractRateLimitInfo(err, { provider: "openai", model: "gpt-4" });
    expect(info?.reason).toBe("billing");
  });

  it("returns null for non-rate-limit errors", () => {
    const err = { status: 500, message: "Server error" };
    expect(extractRateLimitInfo(err, { provider: "test", model: "test" })).toBeNull();
  });
});

describe("decideRateLimitAction", () => {
  const baseInfo: RateLimitInfo = {
    reason: "rate_limit",
    provider: "anthropic",
    model: "claude-3",
    status: 429,
  };

  describe("switch strategy (default)", () => {
    it("returns switch action", () => {
      const decision = decideRateLimitAction(undefined, baseInfo);
      expect(decision.action).toBe("switch");
    });

    it("includes backup model if configured", () => {
      const config: RateLimitConfig = { strategy: "switch", backupModel: "openai/gpt-4" };
      const decision = decideRateLimitAction(config, baseInfo);
      expect(decision.action).toBe("switch");
      expect(decision.switchToModel).toBe("openai/gpt-4");
    });
  });

  describe("wait strategy", () => {
    it("waits when retry-after is within max wait", () => {
      const config: RateLimitConfig = { strategy: "wait", maxWaitSeconds: 120 };
      const info: RateLimitInfo = { ...baseInfo, retryAfterSeconds: 60 };
      const decision = decideRateLimitAction(config, info);
      expect(decision.action).toBe("wait");
      expect(decision.waitSeconds).toBe(60);
    });

    it("switches when retry-after exceeds max wait", () => {
      const config: RateLimitConfig = { strategy: "wait", maxWaitSeconds: 30 };
      const info: RateLimitInfo = { ...baseInfo, retryAfterSeconds: 60 };
      const decision = decideRateLimitAction(config, info);
      expect(decision.action).toBe("switch");
    });

    it("switches when no retry-after available", () => {
      const config: RateLimitConfig = { strategy: "wait" };
      const decision = decideRateLimitAction(config, baseInfo);
      expect(decision.action).toBe("switch");
    });

    it("uses default max wait of 60 seconds", () => {
      const config: RateLimitConfig = { strategy: "wait" };
      const info: RateLimitInfo = { ...baseInfo, retryAfterSeconds: 55 };
      const decision = decideRateLimitAction(config, info);
      expect(decision.action).toBe("wait");

      const info2: RateLimitInfo = { ...baseInfo, retryAfterSeconds: 65 };
      const decision2 = decideRateLimitAction(config, info2);
      expect(decision2.action).toBe("switch");
    });
  });

  describe("ask strategy", () => {
    it("returns ask action with info", () => {
      const config: RateLimitConfig = { strategy: "ask", backupModel: "openai/gpt-4" };
      const info: RateLimitInfo = { ...baseInfo, retryAfterSeconds: 60 };
      const decision = decideRateLimitAction(config, info);
      expect(decision.action).toBe("ask");
      expect(decision.waitSeconds).toBe(60);
      expect(decision.switchToModel).toBe("openai/gpt-4");
    });
  });

  describe("billing errors", () => {
    it("always switches for billing errors regardless of strategy", () => {
      const billingInfo: RateLimitInfo = {
        ...baseInfo,
        reason: "billing",
        status: 402,
        retryAfterSeconds: 60,
      };

      const waitConfig: RateLimitConfig = { strategy: "wait" };
      expect(decideRateLimitAction(waitConfig, billingInfo).action).toBe("switch");

      const askConfig: RateLimitConfig = { strategy: "ask" };
      expect(decideRateLimitAction(askConfig, billingInfo).action).toBe("switch");
    });
  });
});
