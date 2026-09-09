import { describe, expect, it } from "vitest";
import { classifyFailoverReason, classifyFailoverSignal } from "./classify.js";

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
