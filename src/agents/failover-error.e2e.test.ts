import { describe, expect, it } from "vitest";
import {
  coerceToFailoverError,
  describeFailoverError,
  isTimeoutError,
  parseRetryAfterMs,
  resolveFailoverReasonFromError,
} from "./failover-error.js";

describe("failover-error", () => {
  it("infers failover reason from HTTP status", () => {
    expect(resolveFailoverReasonFromError({ status: 402 })).toBe("billing");
    expect(resolveFailoverReasonFromError({ statusCode: "429" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ status: 403 })).toBe("auth");
    expect(resolveFailoverReasonFromError({ status: 408 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 400 })).toBe("format");
    expect(resolveFailoverReasonFromError({ status: 503 })).toBe("timeout");
  });

  it("infers format errors from error messages", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "invalid request format: messages.1.content.1.tool_use.id",
      }),
    ).toBe("format");
  });

  it("infers timeout from common node error codes", () => {
    expect(resolveFailoverReasonFromError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "ECONNRESET" })).toBe("timeout");
  });

  it("infers timeout from abort stop-reason messages", () => {
    expect(resolveFailoverReasonFromError({ message: "Unhandled stop reason: abort" })).toBe(
      "timeout",
    );
    expect(resolveFailoverReasonFromError({ message: "stop reason: abort" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ message: "reason: abort" })).toBe("timeout");
  });

  it("treats AbortError reason=abort as timeout", () => {
    const err = Object.assign(new Error("aborted"), {
      name: "AbortError",
      reason: "reason: abort",
    });
    expect(isTimeoutError(err)).toBe(true);
  });

  it("coerces failover-worthy errors into FailoverError with metadata", () => {
    const err = coerceToFailoverError("credit balance too low", {
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
    expect(err?.name).toBe("FailoverError");
    expect(err?.reason).toBe("billing");
    expect(err?.status).toBe(402);
    expect(err?.provider).toBe("anthropic");
    expect(err?.model).toBe("claude-opus-4-5");
  });

  it("coerces format errors with a 400 status", () => {
    const err = coerceToFailoverError("invalid request format", {
      provider: "google",
      model: "cloud-code-assist",
    });
    expect(err?.reason).toBe("format");
    expect(err?.status).toBe(400);
  });

  it("describes non-Error values consistently", () => {
    const described = describeFailoverError(123);
    expect(described.message).toBe("123");
    expect(described.reason).toBeUndefined();
  });

  it("coerces errors with retryAfterMs from headers", () => {
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
});

// ---------------------------------------------------------------------------
// parseRetryAfterMs
// ---------------------------------------------------------------------------

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
    // Map.get works as function
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
    expect(parseRetryAfterMs(err)).toBe(6_000); // ceil(5.5 * 1000)
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
