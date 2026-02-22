import { describe, expect, it } from "vitest";
import { isRetryableApiError, isTransientHttpError } from "./pi-embedded-helpers.js";

describe("isTransientHttpError", () => {
  it("returns true for retryable 5xx status codes", () => {
    expect(isTransientHttpError("500 Internal Server Error")).toBe(true);
    expect(isTransientHttpError("502 Bad Gateway")).toBe(true);
    expect(isTransientHttpError("503 Service Unavailable")).toBe(true);
    expect(isTransientHttpError("521 <!DOCTYPE html><html></html>")).toBe(true);
    expect(isTransientHttpError("529 Overloaded")).toBe(true);
  });

  it("returns false for non-retryable or non-http text", () => {
    expect(isTransientHttpError("504 Gateway Timeout")).toBe(false);
    expect(isTransientHttpError("429 Too Many Requests")).toBe(false);
    expect(isTransientHttpError("network timeout")).toBe(false);
  });
});

describe("isRetryableApiError", () => {
  it("returns true for transient HTTP errors", () => {
    expect(isRetryableApiError("500 Internal Server Error")).toBe(true);
    expect(isRetryableApiError("502 Bad Gateway")).toBe(true);
    expect(isRetryableApiError("503 Service Unavailable")).toBe(true);
  });

  it("returns true for overloaded errors", () => {
    expect(
      isRetryableApiError(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe(true);
    expect(isRetryableApiError("overloaded_error: Overloaded")).toBe(true);
    expect(isRetryableApiError("Server is overloaded")).toBe(true);
  });

  it("returns true for rate limit errors", () => {
    expect(isRetryableApiError("rate_limit: too many requests")).toBe(true);
    expect(isRetryableApiError("429 Too Many Requests")).toBe(true);
  });

  it("returns true for timeout errors", () => {
    expect(isRetryableApiError("request timed out")).toBe(true);
    expect(isRetryableApiError("deadline exceeded")).toBe(true);
  });

  it("returns false for auth errors", () => {
    expect(isRetryableApiError("invalid_api_key")).toBe(false);
    expect(isRetryableApiError("unauthorized")).toBe(false);
  });

  it("returns false for billing errors", () => {
    expect(isRetryableApiError("insufficient credits")).toBe(false);
    expect(isRetryableApiError("payment required")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(isRetryableApiError("")).toBe(false);
  });
});
