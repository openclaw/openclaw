import { describe, expect, it } from "vitest";
import {
  isAuthErrorMessage,
  isAuthPermanentErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
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

  describe("refresh_token_reused / OAuth degrade patterns", () => {
    const testCases: { label: string; message: string; expectAuthPermanent: boolean }[] = [
      {
        label: "refresh_token_reused code",
        message: "refresh_token_reused",
        expectAuthPermanent: true,
      },
      {
        label: "refresh token has already been used",
        message: "refresh token has already been used",
        expectAuthPermanent: true,
      },
      { label: "sign in again", message: "sign in again", expectAuthPermanent: true },
      {
        label: "signing in again",
        message: "signing in again",
        expectAuthPermanent: true,
      },
      {
        label: "invalid refresh token",
        message: "invalid refresh token",
        expectAuthPermanent: true,
      },
      {
        label: "expired or revoked refresh token",
        message: "Your refresh token has expired or been revoked",
        expectAuthPermanent: true,
      },
      {
        label: "would you like to sign in again",
        message: "Would you like to sign in again?",
        expectAuthPermanent: true,
      },
    ];

    for (const { label, message, expectAuthPermanent } of testCases) {
      it(`classifies ${label} as auth_permanent=${expectAuthPermanent}`, () => {
        if (expectAuthPermanent) {
          expect(isAuthPermanentErrorMessage(message)).toBe(true);
        }
      });
    }

    it("does NOT misclassify invalid_api_key as auth_permanent (stays auth)", () => {
      expect(isAuthPermanentErrorMessage("invalid api key")).toBe(false);
      expect(isAuthErrorMessage("invalid api key")).toBe(true);
    });
  });
});
