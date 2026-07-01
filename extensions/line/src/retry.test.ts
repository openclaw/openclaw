import { describe, it, expect } from "vitest";
import { isRetryableError } from "./retry.js";

describe("retry", () => {
  describe("isRetryableError", () => {
    it("retries 5xx errors", () => {
      expect(isRetryableError({ statusCode: 500 }, 0)).toBe(true);
      expect(isRetryableError({ statusCode: 502 }, 0)).toBe(true);
      expect(isRetryableError({ statusCode: 503 }, 0)).toBe(true);
    });

    it("does not retry 4xx errors", () => {
      expect(isRetryableError({ statusCode: 400 }, 0)).toBe(false);
      expect(isRetryableError({ statusCode: 403 }, 0)).toBe(false);
      expect(isRetryableError({ statusCode: 404 }, 0)).toBe(false);
    });

    it("does not retry 400 with reply token", () => {
      expect(
        isRetryableError({ statusCode: 400, body: { message: "Invalid reply token" } }, 0),
      ).toBe(false);
    });

    it("does not retry 429 with monthly limit", () => {
      expect(
        isRetryableError({ statusCode: 429, body: { message: "monthly limit exceeded" } }, 0),
      ).toBe(false);
    });

    it("retries 429 with rate limit message", () => {
      expect(
        isRetryableError({ statusCode: 429, body: { message: "rate limit exceeded" } }, 0),
      ).toBe(true);
    });

    it("retries network errors (no status)", () => {
      expect(isRetryableError(new Error("ECONNREFUSED"), 0)).toBe(true);
      expect(isRetryableError({}, 0)).toBe(true);
    });

    it("handles string body from LINE SDK v11", () => {
      expect(isRetryableError({ statusCode: 429, body: "monthly limit exceeded" }, 0)).toBe(false);
      expect(isRetryableError({ statusCode: 429, body: "rate limit reached" }, 0)).toBe(true);
      expect(isRetryableError({ statusCode: 400, body: "Invalid reply token" }, 0)).toBe(false);
    });
  });
});
