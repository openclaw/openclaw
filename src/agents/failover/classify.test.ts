import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  classifyFailoverSignal,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isContextOverflowError,
  isFailoverErrorMessage,
  isProviderCompletedErrorFinishReasonMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./classify.js";
import { isAuthPermanentErrorMessage } from "./message-patterns.js";
import { renderRateLimitOrOverloadedCopy } from "./user-copy.js";

describe("HTTP 402 prose classification", () => {
  it.each([
    {
      message: "Prompt tokens limit exceeded. See https://example.invalid/monthly/rate_limit",
      reason: "billing",
    },
    {
      message: "Organization spend limit reached. See https://example.invalid/subscription",
      reason: "rate_limit",
    },
    {
      message:
        '{"help":"https://example.invalid/subscription","message":"Workspace spend limit reached"}',
      reason: "rate_limit",
    },
  ])("classifies prose rather than URL hints: $message", ({ message, reason }) => {
    expect(classifyFailoverSignal({ status: 402, message }, { providerPlugin: null })).toEqual({
      kind: "reason",
      reason,
    });
  });

  it("does not treat a bare leading number and a URL as payment evidence", () => {
    expect(
      classifyFailoverReason(
        "402 records processed. See https://example.invalid/organizations/synthetic/settings/keys",
        { providerPlugin: null },
      ),
    ).toBeNull();
  });
});

describe("request validation behind gateway status codes", () => {
  it.each(["400 Your input exceeds the context window of this model", "413 status code (no body)"])(
    "preserves canonical assistant overflow evidence: %s",
    (message) => {
      expect(classifyFailoverSignal({ message })).toEqual({ kind: "context_overflow" });
    },
  );

  it.each([404, 500])("preserves request-validation semantics for HTTP %s", (status) => {
    expect(
      classifyFailoverSignal({
        status,
        message: `${status} Unknown parameter: 'logprobs'`,
        errorType: "invalid_request_error",
        code: "unknown_parameter",
      }),
    ).toEqual({ kind: "reason", reason: "format" });
    expect(
      classifyFailoverReason(
        `${status} {"error":{"type":"invalid_request_error","message":"Unsupported parameter: logprobs"}}`,
      ),
    ).toBe("format");
  });

  it.each(["timeout", "context_length_exceeded"])(
    "keeps an explicit rejection of %s ahead of message patterns",
    (parameter) => {
      const error = {
        type: "invalid_request_error",
        code: "unknown_parameter",
        message: `Unsupported parameter: ${parameter}`,
      };
      expect(
        classifyFailoverSignal({
          status: 500,
          message: `500 ${error.message}`,
          errorType: error.type,
          code: error.code,
          details: [JSON.stringify(error)],
        }),
      ).toEqual({ kind: "reason", reason: "format" });
      for (const separator of [" ", ": "]) {
        expect(classifyFailoverReason(`502${separator}${JSON.stringify({ error })}`)).toBe(
          "format",
        );
      }
    },
  );

  it.each([
    { status: 401, reason: "auth" },
    { status: 402, reason: "billing" },
    { status: 429, reason: "rate_limit" },
    { status: 499, reason: "timeout" },
    { status: 529, reason: "overloaded" },
  ])("preserves HTTP $status policy for validation-coded errors", ({ status, reason }) => {
    expect(
      classifyFailoverSignal({
        status,
        message: `${status} Unknown parameter: 'logprobs'`,
        errorType: "invalid_request_error",
        code: "unknown_parameter",
      }),
    ).toEqual({ kind: "reason", reason });
  });
});

describe("HTTP request rejection retry eligibility", () => {
  it.each([
    {
      status: 400,
      code: "rate_limit_exceeded",
      message:
        "400 This prompt is longer than the free tier allows for a single request. Shorten it.",
      details: [
        '{"code":"rate_limit_exceeded","message":"This prompt is longer than the free tier allows for a single request. Shorten it."}',
        "rate_limit_exceeded",
      ],
    },
    {
      status: 422,
      message: '422 {"error":{"code":"rate_limit_exceeded","message":"Request rejected"}}',
    },
    { status: 400, code: "RESOURCE_EXHAUSTED", message: "400 provider refusal" },
  ])("does not replay a rejection based only on its inner code: $status", (signal) => {
    expect(classifyFailoverSignal(signal, { providerPlugin: null })).toEqual({
      kind: "reason",
      reason: "rate_limit",
      sameModelRetry: false,
    });
  });

  it.each([
    { status: 400, code: "ThrottlingException", message: "400 Too many concurrent requests" },
    { status: 400, code: "ThrottlingException", message: "400 provider refusal" },
    { status: 429, code: "rate_limit_exceeded", message: "Request rejected" },
    { code: "rate_limit_exceeded", message: "Request rejected" },
    {
      status: 400,
      code: "rate_limit_exceeded",
      message: "400 Request rejected",
      details: ['{"code":"rate_limit_exceeded","message":"Too many concurrent requests"}'],
    },
  ])("retains independent throttling or status evidence: $status $code", (signal) => {
    expect(classifyFailoverSignal(signal, { providerPlugin: null })).toEqual({
      kind: "reason",
      reason: "rate_limit",
    });
  });

  it("preserves a prepared provider's HTTP 400 throttling decision", () => {
    expect(
      classifyFailoverSignal(
        { status: 400, code: "rate_limit_exceeded", message: "Request rejected" },
        {
          providerPlugin: {
            id: "prepared-owner",
            classifyFailoverReason: () => "rate_limit",
          },
        },
      ),
    ).toEqual({ kind: "reason", reason: "rate_limit" });
  });
});

describe("Claude CLI logged-out failures", () => {
  const loggedOutMessage = "Not logged in · Please run /login";

  it("classifies the logged-out response as auth only for claude-cli", () => {
    expect(classifyFailoverReason(loggedOutMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(loggedOutMessage, { provider: "openai" })).toBeNull();
    expect(classifyFailoverReason(loggedOutMessage)).toBeNull();
  });
});

describe("OAuth session expiry", () => {
  const expiredMessage = "Failed to authenticate: OAuth session expired and could not be refreshed";

  it("classifies OAuth expiry as auth only for claude-cli", () => {
    expect(classifyFailoverReason(expiredMessage, { provider: "claude-cli" })).toBe("auth");
    expect(classifyFailoverReason(expiredMessage, { provider: "custom-cli" })).toBe(
      "session_expired",
    );
    expect(classifyFailoverReason(expiredMessage)).toBe("session_expired");
  });
});

describe("Gateway transcript validation vs provider session expiry", () => {
  it("keeps Gateway transcript validation local instead of session_expired", () => {
    expect(classifyFailoverReason("Invalid session transcript entry: model_change")).toBe("format");
    expect(
      classifyFailoverReason("Invalid session transcript entry: model_change", {
        provider: "openrouter",
      }),
    ).toBe("format");
  });

  it("preserves provider session expiry behind HTTP 404", () => {
    expect(classifyFailoverReason("HTTP 404: session not found")).toBe("session_expired");
  });
});

describe("HTTP 5xx status classification", () => {
  // A provider-side 5xx is not a timing failure. Naming it "timeout" both tells
  // the user the request timed out and takes the "timeout" carve-outs in
  // resolveRunFailoverDecision, which skip retry-limit model fallback.
  it("classifies an untyped 500 as server_error", () => {
    expect(classifyFailoverSignal({ status: 500, message: "upstream failure" })).toEqual({
      kind: "reason",
      reason: "server_error",
    });
  });

  it.each([499, 504, 522, 524])("keeps gateway-timeout status %i as timeout", (status) => {
    expect(classifyFailoverSignal({ status, message: "upstream failure" })).toEqual({
      kind: "reason",
      reason: "timeout",
    });
  });

  it("keeps a CDN HTML error page at 529 overloaded, matching the non-HTML body", () => {
    // The HTML path must not disagree with the canonical status mapping just
    // because the body happens to be a page instead of a payload.
    const html =
      "529 <!doctype html><html><head><title>529</title></head><body>Overloaded</body></html>";
    expect(classifyFailoverSignal({ message: html })).toEqual({
      kind: "reason",
      reason: "overloaded",
    });
    expect(classifyFailoverSignal({ status: 529, message: "Overloaded" })).toEqual({
      kind: "reason",
      reason: "overloaded",
    });
  });

  it("keeps a CDN HTML error page at a gateway-timeout status as timeout", () => {
    const html =
      "504 <!doctype html><html><head><title>504</title></head><body>Cloudflare</body></html>";
    expect(classifyFailoverSignal({ message: html })).toEqual({
      kind: "reason",
      reason: "timeout",
    });
  });

  it("still prefers a provider-typed body over the status mapping", () => {
    expect(
      classifyFailoverSignal({
        status: 502,
        message: '{"error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
    ).toEqual({ kind: "reason", reason: "overloaded" });
  });
});

it.each([
  ["api key revoked", true],
  ["invalid_api_key", false],
])("distinguishes permanent auth failure: %s", (message, expected) => {
  expect(isAuthPermanentErrorMessage(message)).toBe(expected);
});

it("ignores multi-section billing explanations", () => {
  expect(
    isBillingErrorMessage(
      "## Payments\nHandle insufficient credits.\n## Plans\nUpgrade your plan.",
    ),
  ).toBe(false);
});

it.each([
  JSON.stringify({ code: 1311, message: "model not on plan", details: "x".repeat(700) }),
  JSON.stringify({
    error: {
      code: "InvalidSubscription",
      message: "Subscription unavailable",
      details: "x".repeat(700),
    },
  }),
  '{"error":{"code":402,"message":"payment required","details":"' + "x".repeat(700) + '"}}',
])("recognizes billing markers in long payloads: %s", (message) => {
  expect(isBillingErrorMessage(message)).toBe(true);
});

it("recognizes Z.ai credential error codes", () => {
  expect(isAuthErrorMessage('{"code":1113,"message":"invalid api endpoint or credentials"}')).toBe(
    true,
  );
});

it("classifies Google's invalid API key response as auth", () => {
  const message =
    "Google Generative AI API error (400): API key not valid. Please pass a valid API key. [code=INVALID_ARGUMENT]";
  expect(isAuthErrorMessage(message)).toBe(true);
  expect(classifyFailoverReason(message)).toBe("auth");
});

it("does not classify unrelated Google invalid arguments as auth", () => {
  const message =
    "Google Generative AI API error (400): Request contains an invalid argument. [code=INVALID_ARGUMENT]";
  expect(isAuthErrorMessage(message)).toBe(false);
  expect(classifyFailoverReason(message)).toBeNull();
});

it("classifies the GLM overload body as overloaded", () => {
  expect(classifyFailoverReason("[1305][该模型当前访问量过大，请您稍后再试]")).toBe("overloaded");
});

it("classifies a harness provider mismatch as format", () => {
  expect(
    classifyFailoverReason(
      'Requested agent harness "codex" does not support openrouter/gpt-5.4 (provider is not one of: codex, openai).',
    ),
  ).toBe("format");
});

it.each([
  ["status: internal server error", true],
  ["provider failed (HTTP 500): upstream apiKey is empty", true],
  ["Proxy notice: Status: Internal Server Error", false],
])("recognizes server status evidence: %s", (message, expected) => {
  expect(isServerErrorMessage(message)).toBe(expected);
});

it.each([
  "Proxy notice: Status: Internal Server Error; upstream connect error",
  "Proxy notice: Status: Internal Server Error; code:500",
])("keeps server evidence retryable without a raw timeout match: %s", (message) => {
  expect(isTimeoutErrorMessage(message)).toBe(false);
  expect(classifyFailoverReason(message)).toBe("timeout");
});

it("distinguishes provider-completed errors from transport timeouts", () => {
  const message = "Provider finish_reason: error";
  expect(isProviderCompletedErrorFinishReasonMessage(message)).toBe(true);
  expect(isTimeoutErrorMessage(message)).toBe(false);
  expect(classifyFailoverReason(message)).toBe("server_error");
});

it("keeps aborted finish reasons in the timeout lane", () => {
  const message = "Provider finish_reason: abort";
  expect(isProviderCompletedErrorFinishReasonMessage(message)).toBe(false);
  expect(isTimeoutErrorMessage(message)).toBe(true);
  expect(classifyFailoverReason(message)).toBe("timeout");
});

it("matches bare terminated transport failures without matching unrelated prose", () => {
  expect(isFailoverErrorMessage("terminated")).toBe(true);
  expect(isFailoverErrorMessage("The user terminated the session manually.")).toBe(false);
});

it("does not classify MALFORMED_FUNCTION_CALL as timeout", () => {
  const message = "Unhandled stop reason: MALFORMED_FUNCTION_CALL";
  expect(isTimeoutErrorMessage(message)).toBe(false);
  expect(classifyFailoverReason(message)).toBeNull();
});

it("classifies the generic LLM request failure as transient", () => {
  expect(classifyFailoverReason("LLM request failed.")).toBe("timeout");
});

it("does not match schema rejection copy as a generic timeout", () => {
  expect(
    isTimeoutErrorMessage(
      "LLM request failed: provider rejected the request schema or tool payload.",
    ),
  ).toBe(false);
});

it("recognizes Google INTERNAL status errors as timeout", () => {
  const message =
    "provider=google model=gemini-3.1-flash-lite-preview got status: INTERNAL upstream failure code:500";
  expect(isTimeoutErrorMessage(message)).toBe(true);
  expect(classifyFailoverReason(message)).toBe("timeout");
});

it("does not treat image dimension rejection as a Cloud Code format error", () => {
  expect(
    isCloudCodeAssistFormatError(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
    ),
  ).toBe(false);
});

it("does not confuse an upload limit with context overflow", () => {
  expect(isContextOverflowError("request size exceeds upload limit")).toBe(false);
});

it("keeps HTTP 429 overload wording in rate-limit backoff and copy", () => {
  const message =
    '429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}';
  expect(classifyFailoverReason(message)).toBe("rate_limit");
  expect(renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw: message })).toBe(
    "⚠️ API rate limit reached. Please try again later.",
  );
});
