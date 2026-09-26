import { describe, expect, it } from "vitest";
import { classifyFailoverReason, classifyFailoverSignal } from "./classify.js";

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

  it.each([404, 500, 502])("preserves request-validation semantics for HTTP %s", (status) => {
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

  it.each([
    "timeout",
    "overloaded",
    "server_error",
    "rate_limit",
    "authentication",
    "context_length_exceeded",
  ])("keeps an explicit rejection of %s ahead of message patterns", (parameter) => {
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
      expect(classifyFailoverReason(`502${separator}${JSON.stringify({ error })}`)).toBe("format");
    }
  });

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

  it.each([
    "invalid session",
    "HTTP 404: session not found",
    "no such session",
    "conversation expired",
  ])("still treats provider session-expiry copy as session_expired: %s", (message) => {
    expect(classifyFailoverReason(message)).toBe("session_expired");
  });
});

describe("HTTP 5xx status classification", () => {
  // A provider-side 5xx is not a timing failure. Naming it "timeout" both tells
  // the user the request timed out and takes the "timeout" carve-outs in
  // resolveRunFailoverDecision, which skip retry-limit model fallback.
  it.each([500, 502, 503, 505, 507, 520, 521, 523])(
    "classifies an untyped %i as server_error",
    (status) => {
      expect(classifyFailoverSignal({ status, message: "upstream failure" })).toEqual({
        kind: "reason",
        reason: "server_error",
      });
    },
  );

  it.each([499, 504, 522, 524])("keeps gateway-timeout status %i as timeout", (status) => {
    expect(classifyFailoverSignal({ status, message: "upstream failure" })).toEqual({
      kind: "reason",
      reason: "timeout",
    });
  });

  it.each([502, 503, 521])("classifies a CDN HTML error page at %i as server_error", (status) => {
    // An HTML body means a CDN answered instead of the provider, so there is
    // no provider error type to read. It is still an upstream failure.
    const html = `${status} <!doctype html><html><head><title>${status}</title></head><body>Cloudflare</body></html>`;
    expect(classifyFailoverSignal({ message: html })).toEqual({
      kind: "reason",
      reason: "server_error",
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
