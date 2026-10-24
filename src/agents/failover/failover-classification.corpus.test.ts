import { expect, it, vi } from "vitest";

// mock-isolation: Test the core classification corpus without loading or consulting provider plugins.
vi.mock("../../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: () => null,
}));

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

function classifyReplyRequest(signal: FailoverSignal) {
  return resolveReplyFailoverFacts(signal, signal.message ?? "").providerRequestError;
}

function expectClassification(signal: FailoverSignal, reason: string) {
  expect(classifyFailoverSignal(signal)).toEqual({ kind: "reason", reason });
}

function expectRequest(message: string, facet: string | null, code: string, status?: number) {
  const signal = { message, status };
  expect(classifyProviderRequestFacets(signal)).toBe(facet);
  expect(classifyReplyRequest(signal)).toMatchObject({ code });
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
  "billing-minimax-chinese-usage-limit",
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
  "billing-context-dashscope-range",
  "billing-context-siliconflow-max-seq-len",
  "billing-context-vllm-decoder-prompt",
  "billing-context-vllm-engine-prompt",
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

it.each(failoverClassificationCorpus.filter(({ id }) => representativeCorpusIds.has(id)))(
  "$id [$source]",
  ({ signal, expected }) => {
    expect(classifyFailoverSignal(signal)).toEqual(expected);
  },
);
it.each([
  [{ status: 524, message: "The model is not available. Please try again later." }, "timeout"],
  [{ errorType: "server_error", message: "The model is not available." }, "server_error"],
  [
    {
      status: 529,
      message: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    },
    "overloaded",
  ],
  [{ message: "Selected model is at capacity. Please try a different model." }, "overloaded"],
] satisfies [FailoverSignal, string][])("keeps outages transient: %j", (signal, reason) => {
  expectClassification(signal, reason);
  expect(classifyReplyRequest(signal)?.code).not.toBe("provider_model_unavailable");
});

it("ignores an embedded 429 substring outside a status context", () => {
  const message = "request id req-4291 failed";
  expect(isRateLimitErrorMessage(message)).toBe(false);
  expect(classifyFailoverSignal({ message })).toBeNull();
});

it.each([
  [
    "Google Generative AI API error (503): The service is currently unavailable. [code=UNAVAILABLE]",
    "server_error",
  ],
  ["Google Generative AI API error (429): Retry later.", "rate_limit"],
  [
    "Google Generative AI API error (503): The service is currently unavailable.",
    "rate_limit",
    429,
  ],
  ["Provider selected candidate (503) before request dispatch.", null],
  [
    'Invalid request: user text contained "Google Generative AI API error (503): unavailable".',
    null,
  ],
] satisfies [string, string | null, number?][])(
  "guards wrapped statuses: %s",
  (message, reason, status?: number) => {
    expect(classifyFailoverSignal({ message, status })).toEqual(
      reason ? { kind: "reason", reason } : null,
    );
  },
);

it("classifies a bare HTTP 503 service-unavailable response as overloaded", () => {
  const message = "503 service unavailable";
  expect(isTimeoutErrorMessage(message)).toBe(false);
  expect(isOverloadedErrorMessage(message)).toBe(true);
  expect(isServerErrorMessage(message)).toBe(false);
  expectClassification({ message }, "overloaded");
  expect(classifyProviderRequestFacets({ message })).toBe("provider-internal-503");
  expect(classifyReplyRequest({ message })).toMatchObject({
    code: "provider_internal_error",
  });
});

it("classifies billing evidence beyond 512 characters", () => {
  const longMessage = `insufficient credits ${"x".repeat(600)}`;
  const truncatedMessage = longMessage.slice(0, 511);
  expect(longMessage.length).toBeGreaterThan(512);
  expect(truncatedMessage.length).toBeLessThan(512);
  expect(isBillingErrorMessage(longMessage)).toBe(true);
  expect(isBillingErrorMessage(truncatedMessage)).toBe(true);
});

it("rotates ambiguous 403 permissions without reply-level auth copy", () => {
  const message = "403 Forbidden: insufficient permissions";
  expect(isAuthErrorMessage(message)).toBe(true);
  expectClassification({ message }, "auth");
  expect(classifyReplyRequest({ message, status: 403 })).toBeUndefined();
});

it("preserves quota guidance for generic provider text with HTTP 429 evidence", () => {
  const message = "Something went wrong while processing your request. Please try again.";
  expectRequest(message, "quota-429", "provider_rate_limit_or_quota_error", 429);
});

it("preserves authentication guidance for provider HTTP 401 failures", () => {
  const message =
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
  expectClassification({ message, status: 401 }, "auth");
  expectRequest(message, null, "provider_authentication_error", 401);
});

it("preserves provider-internal guidance", () => {
  expectRequest(
    "server_error: An error occurred while processing your request. Please include the request ID req_123.",
    "provider-internal",
    "provider_internal_error",
  );
});

it("preserves model-unavailable guidance from the canonical reason", () => {
  const message = "Unknown model: openai/gpt-5.3-codex";
  expectClassification({ message }, "model_not_found");
  expect(classifyProviderRequestFacets({ message })).toBeNull();
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
  expectRequest(message, "conversation-state", "provider_conversation_state_error");
});
const retirement =
  "glm-5.1 was retired at 2026-09-25 00:00:00 -0700 PDT (ref: synthetic-retirement)";

it.each([
  [{ status: 410, message: "Gone", details: [retirement] }, "model_not_found"],
  [{ message: "410 The account has been retired." }, "timeout"],
])("distinguishes model retirement from other HTTP 410s: %j", (signal, reason) => {
  expect(classifyFailoverSignal(signal, { providerPlugin: null })).toEqual({
    kind: "reason",
    reason,
  });
});
