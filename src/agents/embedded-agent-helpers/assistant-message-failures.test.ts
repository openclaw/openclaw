import { APIError } from "openai/core/error";
import { describe, expect, it } from "vitest";
import { projectProviderError } from "../../../packages/ai/src/utils/provider-error.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  buildAssistantFailoverSignal,
  classifyAssistantFailoverReason,
} from "./assistant-message-failures.js";

describe("buildAssistantFailoverSignal provider timing", () => {
  const signalFor = (error: unknown) => {
    const projection = projectProviderError(error);
    return buildAssistantFailoverSignal(makeAssistantMessageFixture(projection));
  };
  const exhaustedTokens = {
    "x-ratelimit-remaining-tokens": "0",
    "x-ratelimit-reset-tokens": "5m",
  };
  const tpm = "Rate limit reached for gpt in organization org-synthetic on tokens per min (TPM)";

  it("keeps OpenAI's explicit try-again time over the bucket's full refill", () => {
    const explicit = new APIError(
      429,
      { message: `${tpm}. Please try again in 6s.` },
      undefined,
      new Headers(exhaustedTokens),
    );
    expect(signalFor(explicit).retryAfterMs).toBe(6_000);
    const resetOnly = new APIError(429, { message: tpm }, undefined, new Headers(exhaustedTokens));
    expect(signalFor(resetOnly).retryAfterMs).toBe(300_000);
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
            violations: Array.from({ length: 12 }, (_, index) => ({
              quotaMetric: `generativelanguage.googleapis.com/generate_content_metric_${index}`,
              quotaId: `GenerateRequestsPerMinutePerProjectPerModel-${index}`,
            })),
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
    const message = makeAssistantMessageFixture({
      errorMessage: "429: rate limited; Retry-After: 7 seconds",
      errorCode: "rate_limit_exceeded",
      retryAfterMs: 62_500,
    });
    expect(buildAssistantFailoverSignal(message).retryAfterMs).toBe(62_500);
    expect(buildAssistantFailoverSignal({ ...message, retryAfterMs: null }).retryAfterMs).toBe(
      Infinity,
    );
    const billing = {
      ...message,
      errorMessage: "402: account balance exhausted",
      errorCode: "insufficient_quota",
    };
    expect(classifyAssistantFailoverReason(billing, { providerOwner: null })).toBe("billing");
  });
  const opencodeGoStalledStreamError = makeAssistantMessageFixture({
    api: "openai-completions",
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
    content: [],
  });

  it("classifies opencode-go provider-owned stalled streams as timeout", () => {
    expect(classifyAssistantFailoverReason(opencodeGoStalledStreamError)).toBe("timeout");
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
    const message = {
      ...opencodeGoStalledStreamError,
      provider: "demo-provider",
      errorCode,
      errorMessage: "provider connection closed",
    };
    expect(classifyAssistantFailoverReason(message)).toBe("timeout");
  });

  it.each([400, 401, 402, 403, 404])(
    "does not classify malformed tool arguments of length %s as auth failures",
    (argumentChars) => {
      const message = makeAssistantMessageFixture({
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
      expect(classifyAssistantFailoverReason(message, { providerOwner: null })).toBeNull();
    },
  );

  it("does not classify caller-aborted assistant messages as provider failover", () => {
    const message = { ...opencodeGoStalledStreamError, stopReason: "aborted" as const };
    expect(classifyAssistantFailoverReason(message)).toBeNull();
  });

  it("uses structured assistant error bodies for model-not-found 400s", () => {
    const message = makeAssistantMessageFixture({
      api: "openai-completions",
      model: "some-model-id",
      errorMessage: "400 Param Incorrect",
      errorCode: "400",
      errorBody:
        '{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}',
      content: [],
    });
    expect(classifyAssistantFailoverReason(message)).toBe("model_not_found");
  });
});
