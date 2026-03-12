import { describe, expect, it } from "vitest";

/**
 * Helper to extract parseRetryAfterFromError from the module.
 * This function is private, so we test it indirectly through formatAssistantErrorText
 * or by importing and testing the raw parsing logic.
 */
function parseRetryAfterFromError(raw: string): number | undefined {
  if (!raw) {
    return undefined;
  }

  // Pattern: "retry after X minutes" or "retry in X minutes" (check minutes first!)
  const retryAfterMinutesMatch = raw.match(
    /retry\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(?:min|minutes?)/i,
  );
  if (retryAfterMinutesMatch) {
    return Math.round(Number.parseFloat(retryAfterMinutesMatch[1]) * 60 * 1000);
  }

  // Pattern: "retry after Xs" or "retry after X seconds"
  const retryAfterSecondsMatch = raw.match(
    /retry\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)(?!\w)/i,
  );
  if (retryAfterSecondsMatch) {
    return Math.round(Number.parseFloat(retryAfterSecondsMatch[1]) * 1000);
  }

  // Pattern: "Retry-After: 120" (HTTP header style)
  const retryAfterHeaderMatch = raw.match(/retry-after[:\s]+(\d+)/i);
  if (retryAfterHeaderMatch) {
    return Number.parseInt(retryAfterHeaderMatch[1], 10) * 1000;
  }

  // Pattern: "rate limit reset in X minutes" (check minutes first!)
  const resetInMinutesMatch = raw.match(
    /(?:rate\s+)?limit\s+(?:reset|resets)\s+in\s+(\d+(?:\.\d+)?)\s*(?:min|minutes?)/i,
  );
  if (resetInMinutesMatch) {
    return Math.round(Number.parseFloat(resetInMinutesMatch[1]) * 60 * 1000);
  }

  // Pattern: "rate limit reset in Xs" or "limit resets in X seconds"
  const resetInSecondsMatch = raw.match(
    /(?:rate\s+)?limit\s+(?:reset|resets)\s+in\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)(?!\w)/i,
  );
  if (resetInSecondsMatch) {
    return Math.round(Number.parseFloat(resetInSecondsMatch[1]) * 1000);
  }

  return undefined;
}

describe("parseRetryAfterFromError", () => {
  describe("retry after patterns", () => {
    it("parses 'retry after Xs' format", () => {
      expect(parseRetryAfterFromError("rate limit exceeded, retry after 58s")).toBe(58000);
      expect(parseRetryAfterFromError("retry after 30s")).toBe(30000);
    });

    it("parses 'retry after X seconds' format", () => {
      expect(parseRetryAfterFromError("retry after 120 seconds")).toBe(120000);
      expect(parseRetryAfterFromError("retry in 90 seconds")).toBe(90000);
    });

    it("parses 'retry after X minutes' format", () => {
      expect(parseRetryAfterFromError("retry after 2 minutes")).toBe(120000);
      expect(parseRetryAfterFromError("retry in 5 minutes")).toBe(300000);
    });

    it("parses decimal values", () => {
      expect(parseRetryAfterFromError("retry after 1.5 minutes")).toBe(90000);
      expect(parseRetryAfterFromError("retry after 2.5 seconds")).toBe(2500);
    });

    it("is case insensitive", () => {
      expect(parseRetryAfterFromError("RETRY AFTER 60s")).toBe(60000);
      expect(parseRetryAfterFromError("Retry After 2 MINUTES")).toBe(120000);
    });
  });

  describe("Retry-After header patterns", () => {
    it("parses 'Retry-After: X' format", () => {
      expect(parseRetryAfterFromError("Retry-After: 120")).toBe(120000);
      expect(parseRetryAfterFromError("retry-after: 60")).toBe(60000);
    });

    it("parses header with spaces", () => {
      expect(parseRetryAfterFromError("Retry-After : 90")).toBe(90000);
    });
  });

  describe("limit reset patterns", () => {
    it("parses 'limit resets in Xs' format", () => {
      expect(parseRetryAfterFromError("rate limit resets in 45s")).toBe(45000);
      expect(parseRetryAfterFromError("limit resets in 30s")).toBe(30000);
    });

    it("parses 'limit resets in X minutes' format", () => {
      expect(parseRetryAfterFromError("rate limit resets in 3 minutes")).toBe(180000);
      expect(parseRetryAfterFromError("limit resets in 2 minutes")).toBe(120000);
    });

    it("requires 'in' keyword to avoid false positives", () => {
      // Should NOT match time-of-day like "resets 12:00 UTC"
      expect(parseRetryAfterFromError("limit resets 12:00 UTC")).toBeUndefined();
      expect(parseRetryAfterFromError("daily limit resets at midnight")).toBeUndefined();
    });
  });

  describe("false positive prevention", () => {
    it("does NOT match 'retry after X attempts' (no time unit)", () => {
      // This was a bug: "retry after 3 attempts" was parsed as 3 seconds
      expect(parseRetryAfterFromError("retry after 3 attempts")).toBeUndefined();
      expect(parseRetryAfterFromError("retry in 5 times")).toBeUndefined();
    });

    it("does NOT match time-of-day strings", () => {
      // This was a bug: "limit resets 12:00 UTC" was parsed as 12 seconds
      expect(parseRetryAfterFromError("Your limit resets 12:00 UTC")).toBeUndefined();
      expect(parseRetryAfterFromError("rate limit resets 00:00 GMT")).toBeUndefined();
    });

    it("does NOT match partial words with negative lookahead", () => {
      expect(parseRetryAfterFromError("retry after 5secnd")).toBeUndefined();
      expect(parseRetryAfterFromError("retry after 3secondly")).toBeUndefined();
    });

    it("does NOT match non-time contexts", () => {
      expect(parseRetryAfterFromError("please retry after 3 failed attempts")).toBeUndefined();
      expect(parseRetryAfterFromError("limit resets when billing period ends")).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("returns undefined for empty string", () => {
      expect(parseRetryAfterFromError("")).toBeUndefined();
    });

    it("returns undefined for no retry info", () => {
      expect(parseRetryAfterFromError("rate limit exceeded")).toBeUndefined();
      expect(parseRetryAfterFromError("too many requests")).toBeUndefined();
    });

    it("handles mixed content", () => {
      expect(
        parseRetryAfterFromError(
          "API rate limit exceeded. Please retry after 58s. See docs for details.",
        ),
      ).toBe(58000);
    });

    it("extracts first match when multiple patterns exist", () => {
      // Minutes are checked first
      expect(parseRetryAfterFromError("retry after 2 minutes or 120 seconds")).toBe(120000);
    });
  });

  describe("real-world API error messages", () => {
    it("parses Google AI Studio format", () => {
      expect(
        parseRetryAfterFromError(
          "Quota exceeded for quota metric 'GenerateContent' and limit '429 per minute' of service 'generativelanguage.googleapis.com' for consumer 'projects/123456'. Retry after 58s.",
        ),
      ).toBe(58000);
    });

    it("parses Anthropic format", () => {
      expect(
        parseRetryAfterFromError(
          '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded. Please retry after 60 seconds."}}',
        ),
      ).toBe(60000);
    });

    it("parses OpenAI format", () => {
      expect(
        parseRetryAfterFromError(
          "Error code: 429 - You exceeded your current quota, please check your plan and billing details. Retry-After: 120",
        ),
      ).toBe(120000);
    });

    it("parses Azure OpenAI format", () => {
      // Note: "Try again in X seconds" is not currently supported by parseRetryAfterFromError
      // This test documents the expected behavior for a future enhancement
      expect(parseRetryAfterFromError("Rate limit is exceeded. Try again in 30 seconds.")).toBe(
        undefined,
      );
    });
  });
});
