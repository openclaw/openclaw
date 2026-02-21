import { describe, expect, it } from "vitest";
import {
  coerceToFailoverError,
  describeFailoverError,
  resolveFailoverReasonFromError,
} from "./failover-error.js";

describe("failover-error", () => {
  it("infers failover reason from HTTP status", () => {
    expect(resolveFailoverReasonFromError({ status: 400, message: "bad request" })).toBe(
      "bad_request",
    );
    expect(resolveFailoverReasonFromError({ status: 400, message: "invalid request format" })).toBe(
      "format",
    );
    expect(resolveFailoverReasonFromError({ status: 401 })).toBe("auth");
    expect(resolveFailoverReasonFromError({ status: 402 })).toBe("billing");
    expect(resolveFailoverReasonFromError({ status: 404, message: "model not found" })).toBe(
      "unknown_model",
    );
    expect(resolveFailoverReasonFromError({ status: 404, message: "resource not found" })).toBe(
      "not_found",
    );
    expect(resolveFailoverReasonFromError({ status: 408 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 402 })).toBe("billing");
    expect(resolveFailoverReasonFromError({ statusCode: "429" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ status: 451 })).toBe("policy");
    expect(resolveFailoverReasonFromError({ status: 499 })).toBe("cancelled");
    expect(resolveFailoverReasonFromError({ status: 502 })).toBe("transport");
    expect(resolveFailoverReasonFromError({ status: 503 })).toBe("server");
    expect(resolveFailoverReasonFromError({ status: 521 })).toBe("server");
  });

  it("infers format errors from error messages", () => {
    expect(
      resolveFailoverReasonFromError({
        message: "invalid request format: messages.1.content.1.tool_use.id",
      }),
    ).toBe("format");
  });

  it("avoids broad statusless bad-request and not-found buckets", () => {
    expect(resolveFailoverReasonFromError({ message: "bad request from local parser" })).toBeNull();
    expect(
      resolveFailoverReasonFromError({ message: "resource not found in local cache" }),
    ).toBeNull();
    expect(resolveFailoverReasonFromError({ message: "model not found" })).toBe("unknown_model");
  });

  it("infers timeout from common node error codes", () => {
    expect(resolveFailoverReasonFromError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ code: "ECONNRESET" })).toBe("transport");
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
});
