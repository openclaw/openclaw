import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  classifyFailoverSignal,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isCloudCodeAssistFormatError,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./classify.js";
import { renderRateLimitOrOverloadedCopy } from "./user-copy.js";

describe("numeric authentication status context", () => {
  it.each([403])("preserves authentication status %s", (status) => {
    for (const message of [
      String(status),
      `HTTP ${status}`,
      `provider returned HTTP ${status}`,
      `status code: ${status}`,
      `response_code=${status}`,
      `Error code ${status} was returned`,
      JSON.stringify({ status }),
      JSON.stringify({ code: String(status) }),
    ]) {
      expect(isAuthErrorMessage(message), message).toBe(true);
      expect(classifyFailoverReason(message, { providerPlugin: null }), message).toBe("auth");
    }
    expect(
      classifyFailoverSignal({ status, message: "provider refusal" }, { providerPlugin: null }),
    ).toEqual({ kind: "reason", reason: "auth" });
  });

  it.each([403])("ignores diagnostic counts and identifiers containing %s", (value) => {
    for (const message of [
      JSON.stringify({ argumentChars: value }),
      JSON.stringify({ requestId: String(value) }),
      `Processed ${value} records`,
    ]) {
      expect(isAuthErrorMessage(message), message).toBe(false);
      expect(classifyFailoverReason(message, { providerPlugin: null }), message).toBeNull();
    }
  });
});

describe("HTTP 402 prose classification", () => {
  it.each([
    {
      message: "Organization spend limit reached. See https://example.invalid/subscription",
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
  it.each([404])("preserves request-validation semantics for HTTP %s", (status) => {
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

  it.each(["context_length_exceeded"])(
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
    { status: 402, reason: "billing" },
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
  ])("does not replay a rejection based only on its inner code: $status", (signal) => {
    expect(classifyFailoverSignal(signal, { providerPlugin: null })).toEqual({
      kind: "reason",
      reason: "rate_limit",
      sameModelRetry: false,
    });
  });

  it.each([{ code: "rate_limit_exceeded", message: "Request rejected" }])(
    "retains independent throttling or status evidence: $status $code",
    (signal) => {
      expect(classifyFailoverSignal(signal, { providerPlugin: null })).toEqual({
        kind: "reason",
        reason: "rate_limit",
      });
    },
  );

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

  it("keeps a CDN HTML error page at a gateway-timeout status as timeout", () => {
    const html =
      "504 <!doctype html><html><head><title>504</title></head><body>Cloudflare</body></html>";
    expect(classifyFailoverSignal({ message: html })).toEqual({
      kind: "reason",
      reason: "timeout",
    });
  });
});

it("ignores multi-section billing explanations", () => {
  expect(
    isBillingErrorMessage(
      "## Payments\nHandle insufficient credits.\n## Plans\nUpgrade your plan.",
    ),
  ).toBe(false);
});

it.each([["status: internal server error", true]])(
  "recognizes server status evidence: %s",
  (message, expected) => {
    expect(isServerErrorMessage(message)).toBe(expected);
  },
);

it.each(["Proxy notice: Status: Internal Server Error; code:500"])(
  "keeps server evidence retryable without a raw timeout match: %s",
  (message) => {
    expect(isTimeoutErrorMessage(message)).toBe(false);
    expect(classifyFailoverReason(message)).toBe("timeout");
  },
);

it("does not treat image dimension rejection as a Cloud Code format error", () => {
  expect(
    isCloudCodeAssistFormatError(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
    ),
  ).toBe(false);
});

it("keeps HTTP 429 overload wording in rate-limit backoff and copy", () => {
  const message =
    '429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}';
  expect(classifyFailoverReason(message)).toBe("rate_limit");
  expect(renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw: message })).toBe(
    "⚠️ The AI service needs a short break. Please try again in a few minutes.",
  );
});
