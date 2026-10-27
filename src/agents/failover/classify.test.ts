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
const validationError = {
  type: validation.errorType,
  code: validation.code,
  message: "Unsupported parameter: context_length_exceeded",
};

describe("failover classification", () => {
  it.each([
    ["403", true],
    ["response_code=403", true],
    ['{"status":403}', true],
    ['{"code":"403"}', true],
    ['{"argumentChars":403}', false],
    ['{"requestId":"403"}', false],
  ] as const)("recognizes auth status but not diagnostic counts: %s", (message, auth) => {
    expect(isAuthErrorMessage(message)).toBe(auth);
    expect(classifyFailoverReason(message, noPlugin)).toBe(auth ? "auth" : null);
  });

  it.each([
    ["auth", { status: 403, message: "provider refusal" }, noPlugin],
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
    ["format", validationSignal(404)],
    [
      "format",
      '404 {"error":{"type":"invalid_request_error","message":"Unsupported parameter: logprobs"}}',
    ],
    [
      null,
      "402 records processed. See https://example.invalid/organizations/synthetic/settings/keys",
      noPlugin,
    ],
    ["auth", { message: "Not logged in · Please run /login", provider: "claude-cli" }],
    [null, { message: "Not logged in · Please run /login", provider: "openai" }],
    [null, "Not logged in · Please run /login"],
    [
      "format",
      {
        status: 500,
        message: `500 ${validationError.message}`,
        ...validation,
        details: [JSON.stringify(validationError)],
      },
    ],
    ["format", `502 ${JSON.stringify({ error: validationError })}`],
    ["format", `502: ${JSON.stringify({ error: validationError })}`],
    ["rate_limit", rejected, noPlugin],
    [
      "rate_limit",
      { status: 400, ...rejected },
      {
        providerPlugin: { id: "prepared-owner", classifyFailoverReason: () => "rate_limit" },
      },
    ],
    ["timeout", { message: "504 <!doctype html><html><body>Cloudflare</body></html>" }],
  ] satisfies [string | null, Signal | string, Options?][])(
    "classification policy: %s for %j",
    (reason, signal, opts?: Options) =>
      expect(
        classifyFailoverSignal(typeof signal === "string" ? { message: signal } : signal, opts),
      ).toEqual(reason ? { kind: "reason", reason } : null),
  );

  it.each([400, 422])("leaves placeholder-only HTTP %i failures unclassified", (status) => {
    for (const body of [
      "[Malformed diagnostic JSON redacted]",
      "[Oversized diagnostic JSON redacted]",
      "[Unserializable]",
    ]) {
      expect(
        classifyFailoverSignal({ status, message: `${status}: ${body}` }, noPlugin),
      ).toBeNull();
    }
    expect(
      classifyFailoverSignal({ status, message: `${status} status code (no body)` }, noPlugin),
    ).toBeNull();
    expect(classifyFailoverSignal(validationSignal(status), noPlugin)).toEqual({
      kind: "reason",
      reason: "format",
    });
    expect(
      classifyFailoverSignal(
        { status, message: "[Malformed diagnostic JSON redacted] Unsupported parameter: logprobs" },
        noPlugin,
      ),
    ).toEqual({ kind: "reason", reason: "format" });
  });

  it("preserves other HTTP status semantics for redacted bodies", () => {
    expect(
      classifyFailoverSignal(
        { status: 500, message: "[Malformed diagnostic JSON redacted]" },
        noPlugin,
      ),
    ).toEqual({ kind: "reason", reason: "server_error" });
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

  it.each([
    [
      isBillingErrorMessage,
      "## Payments\nHandle insufficient credits.\n## Plans\nUpgrade your plan.",
    ],
    [isCloudCodeAssistFormatError, "tool_use.id: image dimensions exceed max allowed size"],
  ] as const)("guards message classification with %s: %s", (predicate, message) =>
    expect(predicate(message)).toBe(false),
  );

  it("keeps server evidence retryable without a raw timeout match", () => {
    const message = "Proxy notice: Status: Internal Server Error; code:500";
    expect(isServerErrorMessage(message)).toBe(true);
    expect(isTimeoutErrorMessage(message)).toBe(false);
    expect(classifyFailoverReason(message)).toBe("timeout");
  });

  it("keeps HTTP 429 overload wording in rate-limit backoff and copy", () => {
    const message =
      '429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}';
    expect(classifyFailoverReason(message)).toBe("rate_limit");
    expect(renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw: message })).toBe(
      "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    );
  });
});
