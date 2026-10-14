import { afterEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(() => null),
}));

// Keep the classification corpus independent of plugin loading; native source
// and compiled payload probes cover the real provider boundary.
vi.mock("../../plugins/provider-failover.js", () => providerRuntimeMocks);

import {
  classifyFailoverSignal,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./classify.js";
import { failoverClassificationCorpus } from "./failover-classification.corpus.cases.test-support.js";
import { classifyProviderRequestFacets } from "./request-error-facets.js";
import { resolveReplyFailoverFacts } from "./request-error-facts.js";
import type { FailoverSignal } from "./signal.js";

afterEach(() => {
  providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockClear();
});

function classifyReplyRequest(signal: FailoverSignal) {
  return resolveReplyFailoverFacts(signal, signal.message ?? "").providerRequestError;
}

// The shared corpus also feeds retry tests; select only distinct classification paths here.
const representativeCorpusIds = new Set([
  "patterns-context-tgi-input",
  "patterns-context-tgi-total",
  "structured-tgi-output-only",
  "patterns-context-lmstudio-loaded-length-400",
  "billing-together-payment-required",
  "billing-proxy-subscription",
  "http-structured-insufficient-quota",
  "xai-403-spending-limit",
  "billing-periodic-limit-402",
  "billing-custom-proxy",
  "billing-zhipu-periodic-limit",
  "billing-subscription-quota-refresh",
  "billing-org-period",
  "retry-429-insufficient-quota-short",
  "billing-cloudflare-521",
  "retry-http-500",
  "openrouter-missing-model",
  "billing-claude-conversation-missing",
  "patterns-html-407",
  "bedrock-deprecated-temperature",
  "billing-context-reasoning-required",
  "http-legacy-bad-request-normalized",
  "billing-image-dimension",
  "billing-image-size",
  "legacy-billing-a-006",
  "legacy-billing-a-034",
  "legacy-billing-a-058",
  "legacy-billing-a-073",
  "legacy-billing-b-003",
  "legacy-billing-b-028",
  "legacy-billing-b-037",
  "legacy-billing-b-055",
  "legacy-billing-b-079",
  "legacy-provider-matchers-024",
]);

describe("golden failover classification corpus", () => {
  it.each(failoverClassificationCorpus.filter(({ id }) => representativeCorpusIds.has(id)))(
    "$id [$source]",
    ({ signal, expected }) => {
      expect(classifyFailoverSignal(signal)).toEqual(expected);
    },
  );
});

describe("cross-layer failover behavior", () => {
  it.each([
    {
      signal: { status: 524, message: "The model is not available. Please try again later." },
      reason: "timeout",
    },
    {
      signal: { errorType: "server_error", message: "The model is not available." },
      reason: "server_error",
    },
    {
      signal: {
        status: 529,
        message: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      },
      reason: "overloaded",
    },
    {
      signal: { message: "Selected model is at capacity. Please try a different model." },
      reason: "overloaded",
    },
  ])("keeps outage evidence transient: $signal", ({ signal, reason }) => {
    expect(classifyFailoverSignal(signal)).toEqual({ kind: "reason", reason });
    expect(classifyReplyRequest(signal)?.code).not.toBe("provider_model_unavailable");
  });

  it("ignores an embedded 429 substring outside a status context", () => {
    const message = "request id req-4291 failed";

    expect(isRateLimitErrorMessage(message)).toBe(false);
    expect(classifyFailoverSignal({ message })).toBeNull();
  });

  it.each([
    {
      signal: {
        message:
          "Google Generative AI API error (503): The service is currently unavailable. [code=UNAVAILABLE]",
      },
      expected: { kind: "reason", reason: "server_error" },
    },
    {
      signal: { message: "Google Generative AI API error (429): Retry later." },
      expected: { kind: "reason", reason: "rate_limit" },
    },
    {
      signal: {
        status: 429,
        message: "Google Generative AI API error (503): The service is currently unavailable.",
      },
      expected: { kind: "reason", reason: "rate_limit" },
    },
    {
      signal: { message: "Provider selected candidate (503) before request dispatch." },
      expected: null,
    },
    {
      signal: {
        message:
          'Invalid request: user text contained "Google Generative AI API error (503): unavailable".',
      },
      expected: null,
    },
  ])("classifies only guarded provider-wrapped statuses: $signal", ({ signal, expected }) => {
    expect(classifyFailoverSignal(signal)).toEqual(expected);
  });

  it("classifies a bare HTTP 503 service-unavailable response as overloaded", () => {
    const message = "503 service unavailable";

    expect(isTimeoutErrorMessage(message)).toBe(false);
    expect(isOverloadedErrorMessage(message)).toBe(true);
    expect(isServerErrorMessage(message)).toBe(false);
    const classification = classifyFailoverSignal({ message });
    expect(classification).toEqual({
      kind: "reason",
      reason: "overloaded",
    });
    const facet = classifyProviderRequestFacets({ message });
    expect(facet).toBe("provider-internal-503");
    expect(classifyReplyRequest({ message })).toMatchObject({
      code: "provider_internal_error",
      technicalMessage: message,
    });
  });

  it("classifies billing evidence beyond 512 characters", () => {
    const longMessage = JSON.stringify({
      error: {
        message: "insufficient credits",
        type: "account_balance_error",
        details: "x".repeat(600),
      },
    });
    const truncatedMessage = longMessage.slice(0, 511);

    expect(longMessage.length).toBeGreaterThan(512);
    expect(truncatedMessage.length).toBeLessThan(512);
    expect(isBillingErrorMessage(longMessage)).toBe(true);
    expect(isBillingErrorMessage(truncatedMessage)).toBe(true);
  });

  it("rotates ambiguous 403 permissions without reply-level auth copy", () => {
    const message = "403 Forbidden: insufficient permissions";

    const classification = classifyFailoverSignal({ message });
    expect(isAuthErrorMessage(message)).toBe(true);
    expect(classification).toEqual({ kind: "reason", reason: "auth" });
    expect(classifyReplyRequest({ message, status: 403 })).toBeUndefined();
  });

  it("preserves quota guidance for generic provider text with HTTP 429 evidence", () => {
    const message = "Something went wrong while processing your request. Please try again.";
    const signal = { message, status: 429 };
    const facet = classifyProviderRequestFacets(signal);

    expect(facet).toBe("quota-429");
    expect(classifyReplyRequest(signal)).toMatchObject({
      code: "provider_rate_limit_or_quota_error",
    });
  });

  it("preserves authentication guidance for provider HTTP 401 failures", () => {
    const message =
      "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
    const signal = { message, status: 401 };
    const classification = classifyFailoverSignal(signal);
    const facet = classifyProviderRequestFacets(signal);

    expect(classification).toEqual({ kind: "reason", reason: "auth" });
    expect(facet).toBeNull();
    expect(classifyReplyRequest(signal)).toMatchObject({ code: "provider_authentication_error" });
  });

  it.each([
    "server_error: An error occurred while processing your request. Please include the request ID req_123.",
  ])("preserves provider-internal guidance for %s", (message) => {
    const facet = classifyProviderRequestFacets({ message });

    expect(facet).toBe("provider-internal");
    expect(classifyReplyRequest({ message })).toMatchObject({ code: "provider_internal_error" });
  });

  it("preserves model-unavailable guidance from the canonical reason", () => {
    const message = "Unknown model: openai/gpt-5.3-codex";
    const classification = classifyFailoverSignal({ message });
    const facet = classifyProviderRequestFacets({ message });

    expect(classification).toEqual({ kind: "reason", reason: "model_not_found" });
    expect(facet).toBeNull();
    expect(classifyReplyRequest({ message })).toMatchObject({
      code: "provider_model_unavailable",
      userMessage: expect.stringContaining("Choose another model in the Control UI"),
    });
  });

  it.each([
    "Custom tool call output is missing for call id: call_live_123.",
    "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
    "400 Function call turn comes immediately after a user turn or after a function response turn.",
    "messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01A09q90qw90lq917835lq9.",
  ])("preserves conversation-state guidance for %s", (message) => {
    const facet = classifyProviderRequestFacets({ message });

    expect(facet).toBe("conversation-state");
    expect(classifyReplyRequest({ message })).toMatchObject({
      code: "provider_conversation_state_error",
    });
  });
});

describe("retired model HTTP 410 classification", () => {
  const retirement =
    "glm-5.1 was retired at 2026-09-25 00:00:00 -0700 PDT (ref: synthetic-retirement)";

  it.each([{ status: 410, message: "Gone", details: [retirement] }])(
    "keeps retired models out of timeout retries: $message",
    (signal) => {
      expect(classifyFailoverSignal(signal, { providerPlugin: null })).toEqual({
        kind: "reason",
        reason: "model_not_found",
      });
    },
  );

  it.each([{ message: "410 The account has been retired.", reason: "timeout" }])(
    "preserves unrelated HTTP 410 behavior: $message",
    ({ message, reason }) => {
      expect(classifyFailoverSignal({ message }, { providerPlugin: null })).toEqual({
        kind: "reason",
        reason,
      });
    },
  );
});
