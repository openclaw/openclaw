import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  classifyFailoverReasonFromHttpStatus,
  isTransientHttpError,
} from "./errors.js";

describe("MiniMax HTTP 520 failover (#49440)", () => {
  describe("isTransientHttpError", () => {
    it("treats HTTP 520 as transient", () => {
      expect(
        isTransientHttpError(
          '520 {"type":"error","error":{"type":"api_error","message":"unknown error, 520 (1000)"}}',
        ),
      ).toBe(true);
    });

    it("still treats HTTP 500 as transient", () => {
      expect(isTransientHttpError("500 Internal Server Error")).toBe(true);
    });

    it("does not treat HTTP 404 as transient", () => {
      expect(isTransientHttpError("404 Not Found")).toBe(false);
    });
  });

  describe("classifyFailoverReasonFromHttpStatus", () => {
    it("classifies 520 as timeout", () => {
      expect(classifyFailoverReasonFromHttpStatus(520)).toBe("timeout");
    });

    it("classifies 520 with body as timeout", () => {
      expect(classifyFailoverReasonFromHttpStatus(520, "unknown error, 520 (1000)")).toBe(
        "timeout",
      );
    });

    it("still classifies 529 as overloaded", () => {
      expect(classifyFailoverReasonFromHttpStatus(529)).toBe("overloaded");
    });

    it("still classifies 429 as rate_limit", () => {
      expect(classifyFailoverReasonFromHttpStatus(429)).toBe("rate_limit");
    });
  });

  describe("classifyFailoverReason — JSON api_error body without status prefix", () => {
    it("classifies MiniMax unknown error as timeout", () => {
      const raw =
        '{"type":"error","error":{"type":"api_error","message":"unknown error, 520 (1000)"}}';
      expect(classifyFailoverReason(raw)).toBe("timeout");
    });

    it("classifies Anthropic internal server error as timeout (backward compat)", () => {
      const raw = '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
      expect(classifyFailoverReason(raw)).toBe("timeout");
    });

    it("does not misclassify billing error as api_error timeout", () => {
      const raw =
        '{"type":"error","error":{"type":"billing_error","message":"insufficient credits"}}';
      expect(classifyFailoverReason(raw)).toBe("billing");
    });

    it("does not misclassify auth error as api_error timeout", () => {
      const raw =
        '{"type":"error","error":{"type":"auth_error","message":"invalid api key provided"}}';
      expect(classifyFailoverReason(raw)).toBe("auth");
    });

    it("does not misclassify api_error body with billing message as timeout", () => {
      // A provider that wraps billing errors under "api_error" type must still resolve to
      // "billing", not "timeout". Previously isJsonApiTransientError would shadow this. (#49440)
      const raw = '{"type":"error","error":{"type":"api_error","message":"insufficient credits"}}';
      expect(classifyFailoverReason(raw)).toBe("billing");
    });

    it("does not misclassify api_error body with auth message as timeout", () => {
      // Same guard: auth errors wrapped in api_error type must resolve to "auth". (#49440)
      const raw =
        '{"type":"error","error":{"type":"api_error","message":"invalid api key provided"}}';
      expect(classifyFailoverReason(raw)).toBe("auth");
    });
  });

  describe("classifyFailoverReason — prefixed with HTTP 520", () => {
    it("classifies 520-prefixed MiniMax error as timeout", () => {
      const raw =
        '520 {"type":"error","error":{"type":"api_error","message":"unknown error, 520 (1000)"}}';
      expect(classifyFailoverReason(raw)).toBe("timeout");
    });
  });
});
