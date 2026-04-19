import { describe, expect, it } from "vitest";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isRateLimitErrorMessage,
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

    it("billing still classified correctly", () => {
      expect(isBillingErrorMessage("insufficient credits")).toBe(true);
    });

    it("auth still classified correctly", () => {
      expect(isAuthErrorMessage("invalid api key provided")).toBe(true);
    });
  });
});

describe("undici stream-terminated errors (reason=null regression)", () => {
  // When an upstream provider (observed with Grok-Vertex streamGenerateContent)
  // closes the fetch body stream mid-read, Node/undici throws a bare
  // `TypeError: terminated`. Without a classifier match the failover reason
  // stays `null`, shouldRotateAssistant stays false, and openclaw retries the
  // same provider until MAX_RUN_LOOP_ITERATIONS, then silently returns an
  // error payload — configured fallback models never get a turn.
  it("classifies bare 'terminated' as timeout", () => {
    expect(isTimeoutErrorMessage("terminated")).toBe(true);
  });

  it("classifies 'Error: terminated' as timeout", () => {
    expect(isTimeoutErrorMessage("Error: terminated")).toBe(true);
  });

  it("classifies 'TypeError: terminated' as timeout", () => {
    expect(isTimeoutErrorMessage("TypeError: terminated")).toBe(true);
  });

  it("does not match 'subscription terminated' (billing-adjacent prose)", () => {
    expect(isTimeoutErrorMessage("subscription terminated due to nonpayment")).toBe(false);
  });

  it("does not match 'account terminated by policy' (auth-adjacent prose)", () => {
    expect(isTimeoutErrorMessage("account terminated by policy")).toBe(false);
  });

  it("does not shadow billing classification on 'subscription terminated'", () => {
    expect(isBillingErrorMessage("subscription terminated — payment required")).toBe(true);
  });
});
