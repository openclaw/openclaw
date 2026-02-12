import { describe, expect, it } from "vitest";
import {
  coerceToFailoverError,
  describeFailoverError,
  resolveFailoverReasonFromError,
} from "./failover-error.js";

describe("failover-error", () => {
  it("infers failover reason from HTTP status", () => {
    expect(resolveFailoverReasonFromError({ status: 402 })).toBe("billing");
    expect(resolveFailoverReasonFromError({ statusCode: "429" })).toBe("rate_limit");
    expect(resolveFailoverReasonFromError({ status: 403 })).toBe("auth");
    expect(resolveFailoverReasonFromError({ status: 408 })).toBe("timeout");
    expect(resolveFailoverReasonFromError({ status: 400 })).toBe("format");
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

  it("extracts x402 payment info from billing error with JSON body", () => {
    const body = JSON.stringify({
      error: "Credits exhausted",
      topup: "https://example.com/billing",
      balance: { budgetLimit: 20, budgetUsed: 20, remaining: 0 },
    });
    const err = coerceToFailoverError(`402 ${body}`, {
      provider: "test-gateway",
      model: "test-model",
    });
    expect(err?.reason).toBe("billing");
    expect(err?.status).toBe(402);
    expect(err?.paymentInfo).toBeDefined();
    expect(err?.paymentInfo?.topupUrl).toBe("https://example.com/billing");
    expect(err?.paymentInfo?.balance?.remaining).toBe(0);
  });

  it("sets paymentInfo to undefined for non-billing errors", () => {
    const err = coerceToFailoverError("rate limit exceeded", {
      provider: "openai",
      model: "gpt-4",
    });
    expect(err?.reason).toBe("rate_limit");
    expect(err?.paymentInfo).toBeUndefined();
  });

  it("sets paymentInfo to undefined for billing errors without x402 body", () => {
    const err = coerceToFailoverError("insufficient credits", {
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
    expect(err?.reason).toBe("billing");
    expect(err?.paymentInfo).toBeUndefined();
  });
});
