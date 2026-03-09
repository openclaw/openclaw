import { describe, expect, it } from "vitest";
import { extractRetryAfterMs, isRetryableLlmError } from "./llm-retry.js";

describe("isRetryableLlmError", () => {
  it("returns true for HTTP 429 rate limit errors", () => {
    expect(isRetryableLlmError({ status: 429 })).toBe(true);
    expect(isRetryableLlmError({ statusCode: 429 })).toBe(true);
  });

  it("returns true for HTTP 500 server error", () => {
    expect(isRetryableLlmError({ status: 500 })).toBe(true);
    expect(isRetryableLlmError({ statusCode: 500 })).toBe(true);
  });

  it("returns true for HTTP 502 bad gateway", () => {
    expect(isRetryableLlmError({ status: 502 })).toBe(true);
    expect(isRetryableLlmError({ statusCode: 502 })).toBe(true);
  });

  it("returns true for HTTP 503 service unavailable", () => {
    expect(isRetryableLlmError({ status: 503 })).toBe(true);
    expect(isRetryableLlmError({ statusCode: 503 })).toBe(true);
  });

  it("returns true for HTTP 504 gateway timeout", () => {
    expect(isRetryableLlmError({ status: 504 })).toBe(true);
    expect(isRetryableLlmError({ statusCode: 504 })).toBe(true);
  });

  it("returns false for HTTP 400 bad request", () => {
    expect(isRetryableLlmError({ status: 400 })).toBe(false);
    expect(isRetryableLlmError({ statusCode: 400 })).toBe(false);
  });

  it("returns false for HTTP 401 unauthorized", () => {
    expect(isRetryableLlmError({ status: 401 })).toBe(false);
    expect(isRetryableLlmError({ statusCode: 401 })).toBe(false);
  });

  it("returns false for HTTP 403 forbidden", () => {
    expect(isRetryableLlmError({ status: 403 })).toBe(false);
    expect(isRetryableLlmError({ statusCode: 403 })).toBe(false);
  });

  it("returns false for HTTP 404 not found", () => {
    expect(isRetryableLlmError({ status: 404 })).toBe(false);
    expect(isRetryableLlmError({ statusCode: 404 })).toBe(false);
  });

  it("returns false for HTTP 402 payment required", () => {
    expect(isRetryableLlmError({ status: 402 })).toBe(false);
    expect(isRetryableLlmError({ statusCode: 402 })).toBe(false);
  });

  it("returns true for network error codes", () => {
    expect(isRetryableLlmError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRetryableLlmError({ code: "esockettimedout" })).toBe(true);
    expect(isRetryableLlmError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableLlmError({ code: "ECONNABORTED" })).toBe(true);
  });

  it("returns true for timeout errors in message", () => {
    expect(isRetryableLlmError({ message: "Request timeout" })).toBe(true);
    expect(isRetryableLlmError({ message: "Operation timed out" })).toBe(true);
    expect(isRetryableLlmError({ message: "DEADLINE_EXCEEDED" })).toBe(true);
    expect(isRetryableLlmError({ message: "Connection timed out" })).toBe(true);
  });

  it("returns false for non-timeout errors in message", () => {
    expect(isRetryableLlmError({ message: "Invalid input" })).toBe(false);
    expect(isRetryableLlmError({ message: "Access denied" })).toBe(false);
  });

  it("returns false for null or undefined", () => {
    expect(isRetryableLlmError(null)).toBe(false);
    expect(isRetryableLlmError(undefined)).toBe(false);
  });

  it("returns false for unknown error codes", () => {
    expect(isRetryableLlmError({ status: 418 })).toBe(false); // I'm a teapot
    expect(isRetryableLlmError({ code: "EUNKNOWN" })).toBe(false);
  });

  it("returns false for other client errors", () => {
    expect(isRetryableLlmError({ status: 408 })).toBe(false); // Request Timeout (client error)
    expect(isRetryableLlmError({ status: 413 })).toBe(false); // Payload Too Large
    expect(isRetryableLlmError({ status: 415 })).toBe(false); // Unsupported Media Type
  });
});

describe("extractRetryAfterMs", () => {
  it("extracts delay from Retry-After header in seconds", () => {
    const headers = {
      get: (name: string) => {
        if (name.toLowerCase() === "retry-after") {
          return "5";
        }
        return null;
      },
    };
    expect(extractRetryAfterMs({ headers })).toBe(5000);
  });

  it("extracts delay from Retry-After header with decimal seconds", () => {
    const headers = {
      get: (name: string) => {
        if (name.toLowerCase() === "retry-after") {
          return "2.5";
        }
        return null;
      },
    };
    expect(extractRetryAfterMs({ headers })).toBe(2500);
  });

  it("extracts delay from x-ratelimit-reset header", () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 10;
    const headers = {
      get: (name: string) => {
        if (name.toLowerCase() === "x-ratelimit-reset") {
          return String(futureTimestamp);
        }
        return null;
      },
    };
    const result = extractRetryAfterMs({ headers });
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(11000);
  });

  it("extracts delay from x-ratelimit-reset-after header", () => {
    const headers = {
      get: (name: string) => {
        if (name.toLowerCase() === "x-ratelimit-reset-after") {
          return "3";
        }
        return null;
      },
    };
    expect(extractRetryAfterMs({ headers })).toBe(3000);
  });

  it("extracts delay from error message with 'retry in' and seconds", () => {
    expect(extractRetryAfterMs({ message: "retry in 5 seconds" })).toBe(5000);
    expect(extractRetryAfterMs({ message: "retry in 5 s" })).toBe(5000);
    expect(extractRetryAfterMs({ message: "retry in 10 sec" })).toBe(10000);
    expect(extractRetryAfterMs({ message: "retry in 2.5 seconds" })).toBe(2500);
  });

  it("extracts delay from error message with 'retry in' and milliseconds", () => {
    expect(extractRetryAfterMs({ message: "retry in 500 ms" })).toBe(500);
    expect(extractRetryAfterMs({ message: "retry in 500 milliseconds" })).toBe(500);
    expect(extractRetryAfterMs({ message: "retry in 1.5 ms" })).toBe(1.5);
  });

  it("extracts delay from error message with 'reset after' and seconds", () => {
    expect(extractRetryAfterMs({ message: "reset after 3 seconds" })).toBe(3000);
    expect(extractRetryAfterMs({ message: "reset after 3 s" })).toBe(3000);
  });

  it("extracts delay from error message with 'reset after' and milliseconds", () => {
    expect(extractRetryAfterMs({ message: "reset after 1000 ms" })).toBe(1000);
    expect(extractRetryAfterMs({ message: "reset after 1000 milliseconds" })).toBe(1000);
  });

  it("returns undefined for null or undefined error", () => {
    expect(extractRetryAfterMs(null)).toBeUndefined();
    expect(extractRetryAfterMs(undefined)).toBeUndefined();
  });

  it("returns undefined for error with no headers or message", () => {
    expect(extractRetryAfterMs({})).toBeUndefined();
    expect(extractRetryAfterMs({ status: 429 })).toBeUndefined();
  });

  it("returns undefined for invalid Retry-After value", () => {
    const headers = {
      get: (name: string) => {
        if (name.toLowerCase() === "retry-after") {
          return "invalid";
        }
        return null;
      },
    };
    expect(extractRetryAfterMs({ headers })).toBeUndefined();
  });

  it("returns undefined for negative Retry-After value", () => {
    const headers = {
      get: (name: string) => {
        if (name.toLowerCase() === "retry-after") {
          return "-5";
        }
        return null;
      },
    };
    expect(extractRetryAfterMs({ headers })).toBeUndefined();
  });

  it("returns undefined for error message without retry hints", () => {
    expect(extractRetryAfterMs({ message: "something went wrong" })).toBeUndefined();
    expect(extractRetryAfterMs({ message: "rate limit exceeded" })).toBeUndefined();
  });

  it("handles case-insensitive unit matching in error messages", () => {
    expect(extractRetryAfterMs({ message: "retry in 5 SECONDS" })).toBe(5000);
    expect(extractRetryAfterMs({ message: "retry in 5 Seconds" })).toBe(5000);
    expect(extractRetryAfterMs({ message: "retry in 5 MS" })).toBe(5);
  });

  it("handles whitespace in error message patterns", () => {
    expect(extractRetryAfterMs({ message: "retry in  5  seconds" })).toBe(5000);
    expect(extractRetryAfterMs({ message: "reset after  10  ms" })).toBe(10);
  });

  it("handles messages without explicit unit (defaults to seconds)", () => {
    expect(extractRetryAfterMs({ message: "retry in 5" })).toBe(5000);
    expect(extractRetryAfterMs({ message: "reset after 10" })).toBe(10000);
    expect(extractRetryAfterMs({ message: "retry in 2.5" })).toBe(2500);
  });

  it("handles optional unit in regex correctly", () => {
    // When unit is omitted, default to seconds (multiply by 1000)
    expect(extractRetryAfterMs({ message: "retry in 3" })).toBe(3000);
    // When unit is "ms", don't multiply
    expect(extractRetryAfterMs({ message: "retry in 3ms" })).toBe(3);
    // When unit is "s", multiply by 1000
    expect(extractRetryAfterMs({ message: "retry in 3s" })).toBe(3000);
  });
});
