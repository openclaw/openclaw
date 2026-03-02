import { describe, expect, it } from "vitest";
import {
  coerceToFailoverError,
  describeFailoverError,
  isTimeoutError,
  resolveFailoverReasonFromError,
  resolveFailoverStatus,
} from "./failover-error.js";

describe("failover-error", () => {
  it("infers failover reason from HTTP status", () => {
    expect(resolveFailoverReasonFromError({ status: 402 })).toBe("billing");
    expect(resolveFailoverReasonFromError({ statusCode: "429" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ status: 403 })).toBe("auth");
    expect(resolveFailoverReasonFromError({ status: 408 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 400 })).toBe("format");
    // Transient server errors (502/503/504) should trigger failover as timeout.
    expect(resolveFailoverReasonFromError({ status: 502 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 503 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 504 })).toBe("timeout");
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

  it("401/403 with generic message still returns auth (backward compat)", () => {
    expect(resolveFailoverReasonFromError({ status: 401, message: "Unauthorized" })).toBe("auth");
    expect(resolveFailoverReasonFromError({ status: 403, message: "Forbidden" })).toBe("auth");
  });

  it("401 with permanent auth message returns auth_permanent", () => {
    expect(resolveFailoverReasonFromError({ status: 401, message: "invalid_api_key" })).toBe(
      "auth_permanent",
    );
  });

  it("403 with revoked key message returns auth_permanent", () => {
    expect(resolveFailoverReasonFromError({ status: 403, message: "api key revoked" })).toBe(
      "auth_permanent",
    );
  });

  it("resolveFailoverStatus maps auth_permanent to 403", () => {
    expect(resolveFailoverStatus("auth_permanent")).toBe(403);
  });

  it("coerces permanent auth error with correct reason", () => {
    const err = coerceToFailoverError(
      { status: 401, message: "invalid_api_key" },
      { provider: "anthropic", model: "claude-opus-4-6" },
    );
    expect(err?.reason).toBe("auth_permanent");
    expect(err?.provider).toBe("anthropic");
  });

  it("describes non-Error values consistently", () => {
    const described = describeFailoverError(123);
    expect(described.message).toBe("123");
    expect(described.reason).toBeUndefined();
  });
});
