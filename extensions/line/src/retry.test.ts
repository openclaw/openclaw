import { describe, it, expect, vi } from "vitest";
import { isRetryableError, withRetry } from "./retry.js";

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
  });

  describe("withRetry", () => {
    it("resolves on first attempt", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      await expect(withRetry(fn)).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries and succeeds", async () => {
      const fn = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce("ok");
      await expect(
        withRetry(fn, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 }),
      ).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("throws after exhausting retries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("persistent"));
      await expect(
        withRetry(fn, { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100 }),
      ).rejects.toThrow("persistent");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does not retry non-retryable errors", async () => {
      const fn = vi.fn().mockRejectedValue({ statusCode: 400 });
      await expect(withRetry(fn)).rejects.toEqual({ statusCode: 400 });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
