import { describe, expect, it } from "vitest";
import { isCloudCodeAssistFormatError } from "./classify-core.js";
import {
  classifyFailoverReason,
  classifyFailoverSignal,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./classify.js";
import { renderRateLimitOrOverloadedCopy } from "./user-copy.js";

const noPlugin = { providerPlugin: null };
type Signal = Parameters<typeof classifyFailoverSignal>[0];
type Options = Parameters<typeof classifyFailoverSignal>[1];
const classifyWithoutPlugin = (message: string) => classifyFailoverReason(message, noPlugin);
const expectReason = (expected: string, signal: Signal, opts?: Options) =>
  expect(classifyFailoverSignal(signal, opts)).toEqual({ kind: "reason", reason: expected });
const expectRaw = (
  raw: string,
  expected: string | null,
  opts?: Parameters<typeof classifyFailoverReason>[1],
) => expect(classifyFailoverReason(raw, opts)).toBe(expected);
const validation = { errorType: "invalid_request_error", code: "unknown_parameter" };
const validationSignal = (status: number) => ({
  status,
  message: `${status} Unknown parameter: 'logprobs'`,
  ...validation,
});
const rateLimitCode = "rate_limit_exceeded";
const rejected = { code: rateLimitCode, message: "Request rejected" };
const promptRejection = {
  code: rateLimitCode,
  message: "This prompt is longer than the free tier allows for a single request. Shorten it.",
};

describe("failover classification", () => {
  it("preserves authentication status 403", () => {
    for (const message of [
      "403",
      "HTTP 403",
      "provider returned HTTP 403",
      "status code: 403",
      "response_code=403",
      "Error code 403 was returned",
      JSON.stringify({ status: 403 }),
      JSON.stringify({ code: "403" }),
    ]) {
      expect(isAuthErrorMessage(message), message).toBe(true);
      expect(classifyWithoutPlugin(message), message).toBe("auth");
    }
    expectReason("auth", { status: 403, message: "provider refusal" }, noPlugin);
  });

  it("ignores diagnostic counts and identifiers containing 403", () => {
    for (const message of [
      JSON.stringify({ argumentChars: 403 }),
      JSON.stringify({ requestId: "403" }),
      "Processed 403 records",
    ]) {
      expect(isAuthErrorMessage(message), message).toBe(false);
      expect(classifyWithoutPlugin(message), message).toBeNull();
    }
  });

  it.each([
    [
      "rate_limit",
      {
        status: 402,
        message: "Organization spend limit reached. See https://example.invalid/subscription",
      },
      noPlugin,
    ],
    ["server_error", { status: 500, message: "upstream failure" }],
    ["billing", validationSignal(402)],
    ["overloaded", validationSignal(529)],
    ["rate_limit", rejected, noPlugin],
    [
      "rate_limit",
      { status: 400, ...rejected },
      {
        providerPlugin: { id: "prepared-owner", classifyFailoverReason: () => "rate_limit" },
      },
    ],
    ["timeout", { message: "504 <!doctype html><html><body>Cloudflare</body></html>" }],
  ] satisfies [string, Signal, Options?][])(
    "HTTP policy: %s for %j",
    (expected, signal, opts?: Options) => expectReason(expected, signal, opts),
  );

  it("does not treat a bare leading number and a URL as payment evidence", () =>
    expectRaw(
      "402 records processed. See https://example.invalid/organizations/synthetic/settings/keys",
      null,
      noPlugin,
    ));

  it("preserves request-validation semantics for HTTP 404", () => {
    expectReason("format", validationSignal(404));
    expectRaw(
      '404 {"error":{"type":"invalid_request_error","message":"Unsupported parameter: logprobs"}}',
      "format",
    );
  });

  it("keeps an explicit rejection ahead of context-length message patterns", () => {
    const error = {
      type: validation.errorType,
      code: validation.code,
      message: "Unsupported parameter: context_length_exceeded",
    };
    expectReason("format", {
      status: 500,
      message: `500 ${error.message}`,
      ...validation,
      details: [JSON.stringify(error)],
    });
    for (const separator of [" ", ": "]) {
      expectRaw(`502${separator}${JSON.stringify({ error })}`, "format");
    }
  });

  it.each([
    {
      status: 400,
      code: promptRejection.code,
      message: `400 ${promptRejection.message}`,
      details: [JSON.stringify(promptRejection), rateLimitCode],
    },
    {
      status: 422,
      message: `422 ${JSON.stringify({ error: rejected })}`,
    },
  ])("does not replay a rejection based only on its inner code: $status", (signal) => {
    expect(classifyFailoverSignal(signal, noPlugin)).toEqual({
      kind: "reason",
      reason: "rate_limit",
      sameModelRetry: false,
    });
  });

  it("classifies the logged-out response as auth only for claude-cli", () => {
    const message = "Not logged in · Please run /login";
    expectRaw(message, "auth", { provider: "claude-cli" });
    expectRaw(message, null, { provider: "openai" });
    expectRaw(message, null);
  });

  it.each([
    [
      isBillingErrorMessage,
      "## Payments\nHandle insufficient credits.\n## Plans\nUpgrade your plan.",
      false,
    ],
    [isServerErrorMessage, "status: internal server error", true],
    [
      isCloudCodeAssistFormatError,
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
      false,
    ],
  ] as const)("guards message classification with %s: %s", (predicate, message, expected) =>
    expect(predicate(message)).toBe(expected),
  );

  it("keeps server evidence retryable without a raw timeout match", () => {
    const message = "Proxy notice: Status: Internal Server Error; code:500";
    expect(isTimeoutErrorMessage(message)).toBe(false);
    expectRaw(message, "timeout");
  });

  it("keeps HTTP 429 overload wording in rate-limit backoff and copy", () => {
    const message =
      '429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}';
    expectRaw(message, "rate_limit");
    expect(renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw: message })).toBe(
      "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    );
  });
});
