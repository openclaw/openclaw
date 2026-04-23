import { describe, expect, it } from "vitest";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./failover-matches.js";

describe("Z.ai vendor error codes (#48988)", () => {
  describe("error 1311 — model not included in subscription plan", () => {
    it("classifies Z.ai 1311 JSON body as billing", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
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

  it("does not classify prefixed plain internal server error status prose", () => {
    expect(isServerErrorMessage("Proxy notice: Status: Internal Server Error")).toBe(false);
  });
});

describe("bare transport-interruption tokens classify as timeout", () => {
  it.each(["terminated", "aborted", "cancelled", "canceled"])(
    "classifies bare %s as timeout",
    (raw) => {
      expect(isTimeoutErrorMessage(raw)).toBe(true);
    },
  );

  it.each([
    "Terminated",
    "TERMINATED",
    " terminated ",
    "Aborted",
    "Cancelled",
    "Canceled",
  ])("classifies case/whitespace variants of bare interrupt tokens as timeout: %s", (raw) => {
    expect(isTimeoutErrorMessage(raw)).toBe(true);
  });

  it("does not classify assistant prose containing the word terminated", () => {
    // The pattern is anchored with ^...$ so running text stays unclassified
    // and only falls into timeout via other patterns (or not at all).
    expect(isTimeoutErrorMessage("the subprocess was terminated after five seconds")).toBe(
      false,
    );
  });
});

describe("human-readable network interruption phrases classify as timeout", () => {
  it.each([
    "connection refused",
    "connection reset",
    "connection aborted",
    "connection closed",
    "network is unreachable",
    "host is unreachable",
    "socket hang up",
    "socket hangup",
  ])("classifies %s as timeout", (raw) => {
    expect(isTimeoutErrorMessage(raw)).toBe(true);
  });

  it("does not classify unrelated phrases with the word connection", () => {
    expect(isTimeoutErrorMessage("connection established to database")).toBe(false);
  });
});
