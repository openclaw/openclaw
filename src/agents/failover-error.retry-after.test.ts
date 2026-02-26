import { describe, expect, it } from "vitest";
import { coerceToFailoverError, parseRetryAfterMs } from "./failover-error.js";

describe("parseRetryAfterMs", () => {
  it("returns null for non-object values", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("string")).toBeNull();
    expect(parseRetryAfterMs(42)).toBeNull();
  });

  it("extracts from headers object with get method", () => {
    const err = {
      message: "rate limited",
      headers: new Map([["retry-after", "15"]]),
    };
    expect(parseRetryAfterMs(err)).toBe(15_000);
  });

  it("extracts from plain headers object", () => {
    const err = {
      message: "rate limited",
      headers: { "retry-after": "10" },
    };
    expect(parseRetryAfterMs(err)).toBe(10_000);
  });

  it("extracts from retry_after field (SDK-style)", () => {
    const err = {
      message: "rate limited",
      retry_after: 5.5,
    };
    expect(parseRetryAfterMs(err)).toBe(5_500); // ceil(5.5 * 1000) = 5500
  });

  it("extracts from retryAfter field", () => {
    const err = {
      message: "rate limited",
      retryAfter: 3,
    };
    expect(parseRetryAfterMs(err)).toBe(3_000);
  });

  it("extracts from error message pattern", () => {
    const err = {
      message: "Rate limited. Please retry after 30 seconds.",
    };
    expect(parseRetryAfterMs(err)).toBe(30_000);
  });

  it("extracts 'try again in N seconds' pattern", () => {
    const err = {
      message: "Too many requests. Try again in 60 seconds.",
    };
    expect(parseRetryAfterMs(err)).toBe(60_000);
  });

  it("walks into cause", () => {
    const err = {
      message: "wrapper",
      cause: {
        message: "rate limited",
        headers: { "retry-after": "20" },
      },
    };
    expect(parseRetryAfterMs(err)).toBe(20_000);
  });

  it("returns null when no retry-after info found", () => {
    expect(parseRetryAfterMs({ message: "something broke" })).toBeNull();
  });
});

describe("coerceToFailoverError retryAfterMs", () => {
  it("carries retryAfterMs from headers", () => {
    const err = coerceToFailoverError(
      {
        message: "rate limit exceeded",
        status: 429,
        headers: { "retry-after": "30" },
      },
      { provider: "anthropic", model: "claude-opus-4-6" },
    );
    expect(err?.retryAfterMs).toBe(30_000);
    expect(err?.reason).toBe("rate_limit");
  });

  it("carries retryAfterMs from message pattern", () => {
    const err = coerceToFailoverError(
      { message: "Too many requests. Try again in 45 seconds.", status: 429 },
      { provider: "openai" },
    );
    expect(err?.retryAfterMs).toBe(45_000);
  });

  it("omits retryAfterMs when not parseable", () => {
    const err = coerceToFailoverError(
      { message: "rate limit exceeded", status: 429 },
      { provider: "anthropic" },
    );
    expect(err?.retryAfterMs).toBeUndefined();
  });
});
