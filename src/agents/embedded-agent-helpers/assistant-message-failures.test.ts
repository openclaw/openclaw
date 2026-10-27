import { APIError } from "openai/core/error";
import { describe, expect, it } from "vitest";
import { projectProviderError } from "../../../packages/ai/src/utils/provider-error.js";
import { makeAssistantMessageFixture as message } from "../test-helpers/assistant-message-fixtures.js";
import {
  buildAssistantFailoverSignal as signal,
  classifyAssistantFailoverReason as classify,
} from "./assistant-message-failures.js";

describe("buildAssistantFailoverSignal provider timing", () => {
  const signalFor = (error: unknown) => signal(message(projectProviderError(error)));
  const exhaustedTokens = {
    "x-ratelimit-remaining-tokens": "0",
    "x-ratelimit-reset-tokens": "5m",
  };
  const tpm = "Rate limit reached for gpt in organization org-synthetic on tokens per min (TPM)";

  it.each([
    [`${tpm}. Please try again in 6s.`, 6_000],
    [tpm, 300_000],
  ])("uses the explicit retry delay or falls back to the bucket refill: %s", (text, delay) => {
    const error = new APIError(429, { message: text }, undefined, new Headers(exhaustedTokens));
    expect(signalFor(error).retryAfterMs).toBe(delay);
  });

  it("keeps Gemini RetryInfo that body truncation would cut off, in any key order", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "You exceeded your current quota.",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaMetric: "synthetic-quota-metric".repeat(60) }],
          },
          { retryDelay: "32s", "@type": "type.googleapis.com/google.rpc.RetryInfo" },
        ],
      },
    });
    expect(body.indexOf("retryDelay")).toBeGreaterThan(1_000);
    const error = Object.assign(new Error("429 Too Many Requests"), { status: 429, body });
    const projection = projectProviderError(error);
    expect(projection.errorBody).not.toContain("retryDelay");
    expect(projection.retryAfterMs).toBe(32_000);
    expect(signalFor(error).retryAfterMs).toBe(32_000);
  });
});

describe("classifyAssistantFailoverReason", () => {
  it("uses the recorded provider floor even when the display message was clipped", () => {
    const error = message({
      errorMessage: "429: rate limited; Retry-After: 7 seconds",
      errorCode: "rate_limit_exceeded",
      retryAfterMs: 62_500,
    });
    expect(signal(error).retryAfterMs).toBe(62_500);
    expect(signal({ ...error, retryAfterMs: null }).retryAfterMs).toBe(Infinity);
    const billing = {
      ...error,
      errorMessage: "402: account balance exhausted",
      errorCode: "insufficient_quota",
    };
    expect(classify(billing, { providerOwner: null })).toBe("billing");
  });
  const stalled = message({
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
    content: [],
  });

  it.each([
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_DNS_RESOLVE_FAILED",
    "UND_ERR_CONNECT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ])("classifies structured %s assistant errors as timeouts", (errorCode) => {
    const error = {
      ...stalled,
      provider: "demo-provider",
      errorCode,
      errorMessage: "provider connection closed",
    };
    expect(classify(error)).toBe("timeout");
  });

  it.each([400, 401, 402, 403, 404])(
    "does not classify malformed tool arguments of length %s as auth failures",
    (argumentChars) => {
      const error = message({
        provider: "anthropic",
        errorMessage: "Provider completed tool call with malformed JSON arguments",
        errorCode: "malformed_tool_call_arguments",
        errorBody: JSON.stringify({
          code: "malformed_tool_call_arguments",
          argumentChars,
          argumentHash: "synthetic-hash",
          repairAttempted: true,
        }),
        content: [],
      });
      expect(classify(error, { providerOwner: null })).toBeNull();
    },
  );

  it.each([
    [stalled, "timeout"],
    [{ ...stalled, stopReason: "aborted" }, null],
    [
      message({
        errorMessage: "400 Param Incorrect",
        errorCode: "400",
        errorBody:
          '{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}',
      }),
      "model_not_found",
    ],
  ] as const)("classifies assistant failure %j as %s", (error, reason) => {
    expect(classify(error)).toBe(reason);
  });
});
