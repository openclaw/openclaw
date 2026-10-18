import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import {
  classifyAssistantFailoverReason,
  formatBillingErrorMessage,
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
  getApiErrorPayloadFingerprint,
  formatRawAssistantErrorForUi,
} from "./embedded-agent-helpers.js";
import { renderUserFacingText } from "./embedded-agent-helpers/user-facing-text.js";
import { isRawApiErrorPayload } from "./failover/user-copy.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { withPreparedFailoverProviders } from "./test-helpers/provider-failover-generation.js";

describe("formatAssistantErrorText", () => {
  const BILLING_ERROR_USER_MESSAGE =
    "⚠️ The AI service reported a billing problem. Check your account's credit balance and usage limits before trying again.";
  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    makeAssistantMessageFixture({
      errorMessage,
      content: [{ type: "text", text: errorMessage }],
    });
  const authInvalidTokenCopy =
    "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.";
  const replyLimitCopy =
    "The reply length is set too high for this model. Lower its reply limit in the Control UI settings, or choose another model.";
  const tokenLimitBody = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "max_tokens (384000) exceeds model's maximum output tokens (65536) for model deepseek-v4-flash:0731",
    },
  });
  const expectCopy = (raw: string, expected: string) =>
    expect(formatAssistantErrorText(makeAssistantError(raw))).toBe(expected);
  const expectBothCopies = (msg: AssistantMessage, expected: string) => {
    expect(formatAssistantErrorText(msg)).toBe(expected);
    expect(formatUserFacingAssistantErrorText(msg)).toBe(expected);
  };

  it.each([
    [
      '<!DOCTYPE html><html><head><title>Just a moment...</title><link rel="dns-prefetch" href="//chatgpt.com"></head><body><span id="challenge-error-text">Enable JavaScript and cookies to continue</span><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>',
      "Couldn't reach the AI service. Try again in a moment. If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    ],
    ["request ended without sending any chunks", "LLM request timed out."],
    [
      "file lock timeout for /tmp/openclaw-oauth-refresh.lock",
      "Another sign-in is still in progress. Wait a moment, then try again.",
    ],
    ["403 <!DOCTYPE html><html><body>Access denied</body></html>", authInvalidTokenCopy],
    [
      "407 Proxy Authentication Required",
      "Couldn't connect to the AI service. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    ],
    [
      "Hostname/IP does not match certificate's altnames: Host: api.example.com",
      "Couldn't connect securely to the AI service. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    ],
  ])("formats assistant error: %s", (raw, expected) => {
    expectCopy(raw, expected);
  });

  it("explains client-restricted free tiers without exposing the provider response", () => {
    const msg = makeAssistantError(
      '403 {"type":"error","error":{"type":"FreeTierError","message":"OpenCode\\u0027s free tier can only be used from within OpenCode"}}',
    );
    expect(formatUserFacingAssistantErrorText(msg, { provider: "opencode" })).toBe(
      "This model's free tier is limited to the provider's own client. Choose another model or use a paid plan.",
    );
  });

  it("surfaces provider-specific rate limit message with reset time (#54433)", () => {
    const msg = makeAssistantError(
      "You have hit your ChatGPT usage limit (go plan). Try again in ~4381 min.",
    );
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("4381 min");
    expect(result).toContain("go plan");
    expect(result).not.toBe(
      "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    );
  });

  it("returns context overflow for Anthropic 'Request size exceeds model context window'", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
    );
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns a reasoning-required message for mandatory reasoning endpoint errors", () => {
    const msg = makeAssistantError(
      "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
    );
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Reasoning is required");
    expect(result).toContain("/think minimal");
    expect(result).not.toContain("Context overflow");
  });
  it.each([
    [
      '429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}',
      "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    ],
    [
      "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID synthetic-provider-request-001 in your message.",
      "The AI service returned an internal error. Please try again in a moment.",
    ],
    [
      "Error: 521 <!DOCTYPE html><html><body>rate limit</body></html>",
      "Couldn't reach the AI service. Try again in a moment. If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    ],
    [
      "OAuth token refresh failed for openai: invalid_grant. Please try again or re-authenticate.",
      authInvalidTokenCopy,
    ],
    [
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      authInvalidTokenCopy,
    ],
    [
      'OAuth refresh call "refreshProviderOAuthCredentialWithPlugin(openai)" exceeded hard timeout (120000ms)',
      "Signing in took too long. Try again in a moment. If it keeps happening, sign in again under Models in the Control UI.",
    ],
    [
      'Unexpected event order, got message_start before receiving "message_stop"',
      "LLM request failed: provider returned an invalid streaming response. Please try again.",
    ],
    ["HTTP 402 Payment Required", BILLING_ERROR_USER_MESSAGE],
    ["Provider finish_reason: error", "Provider finish_reason: error"],
  ])("formats provider error: %s", (errorText, expected) => {
    expectCopy(errorText, expected);
  });
  it("returns a recovery hint when tool call input is missing", () => {
    const msg = makeAssistantError("tool_use.input: Field required");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Session history looks corrupted");
    expect(result).toContain("/new");
  });
  it("prioritizes thinking-signature replay recovery over invalid-request formatting", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
    );
    const replayCopy =
      "Session history or replay state is invalid. Use /new to start a fresh session and try again.";
    expectBothCopies(msg, replayCopy);
  });
  it("handles JSON-wrapped role errors", () => {
    const msg = makeAssistantError('{"error":{"message":"400 Incorrect role information"}}');
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Message ordering conflict");
    expect(result).not.toContain("400");
  });
  it("points unclassified failures to diagnostics", () => {
    expect(
      formatUserFacingAssistantErrorText(makeAssistantError("opaque-private-provider-detail"), {
        provider: "openai",
        model: "test-model",
      }),
    ).toBe(
      "⚠️ OpenClaw couldn't finish this reply. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
    );
  });

  it("keeps the generic last resort when no classified facts are available", () => {
    const raw = "opaque-private-provider-detail";
    const msg = makeAssistantMessageFixture({
      errorMessage: raw,
      provider: undefined,
      model: undefined,
      errorType: undefined,
      errorCode: undefined,
      errorBody: undefined,
      content: [{ type: "text", text: raw }],
    });

    expect(formatUserFacingAssistantErrorText(msg)).toBe(GENERIC_ASSISTANT_ERROR_TEXT);
  });

  it("never includes a raw provider body in classified failure copy", () => {
    const raw = "HTTP 500: Authorization: Bearer sk-secret https://secret.example/path opaque-body";
    const userFacing = formatUserFacingAssistantErrorText(makeAssistantError(raw), {
      provider: "openai",
      providerOwner: {
        id: "openai",
        classifyFailoverReason: () => "server_error",
      },
      model: "gpt-5.6-luna",
    });

    expect(userFacing).not.toMatch(/sk-secret|secret\.example|opaque-body|Authorization/iu);
  });

  it("classifies service_unavailable text as provider overload", () => {
    expect(
      formatUserFacingAssistantErrorText(makeAssistantError("HTTP 503: service_unavailable"), {
        provider: "openai",
        model: "gpt-5.6-luna",
      }),
    ).toContain("overloaded");
  });

  it("points classified authentication failures at provider re-authentication", () => {
    const raw = "HTTP 401: opaque-auth-canary";
    const userFacing = formatUserFacingAssistantErrorText(makeAssistantError(raw), {
      provider: "openai",
      providerOwner: {
        id: "openai",
        classifyFailoverReason: () => "auth",
      },
      model: "gpt-5.6-luna",
    });

    expect(userFacing).toBe(
      "⚠️ Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
    );
    expect(userFacing).not.toContain("opaque-auth-canary");
  });
  it("classifies provider upstream_error payloads as server errors for fallback", () => {
    const msg = makeAssistantMessageFixture({
      errorMessage: "Upstream request failed",
      errorType: "upstream_error",
    });

    withPreparedFailoverProviders(["openai"], () => {
      expect(classifyAssistantFailoverReason(msg, { provider: "openai" })).toBe("server_error");
      expect(
        classifyAssistantFailoverReason(
          makeAssistantError(
            '{"error":{"message":"Upstream request failed","type":"upstream_error","param":"","code":null}}',
          ),
        ),
      ).toBe("server_error");
    });
  });
  it.each([
    ["provider message", makeAssistantError(tokenLimitBody)],
    [
      "structured body",
      makeAssistantMessageFixture({
        errorMessage: "400 Param Incorrect",
        errorCode: "400",
        errorBody: tokenLimitBody,
        content: [],
      }),
    ],
  ])("surfaces token limits from %s", (_carrier, msg) => {
    const userFacing = formatUserFacingAssistantErrorText(msg);
    expect(userFacing).toBe(replyLimitCopy);
    expect(userFacing).not.toContain("deepseek-v4-flash:0731");
  });

  it("surfaces token limits from provider-wrapped HTTP errors", () => {
    expectBothCopies(
      makeAssistantError(
        "Error: OpenAI API error (400): max_tokens (384000) exceeds model's maximum output tokens (65536)",
      ),
      replyLimitCopy,
    );
  });
  it("keeps structured 429 billing failures ahead of rate-limit copy", () => {
    const msg = makeAssistantError(
      'HTTP 429: {"error":"insufficient_balance","message":"Insufficient account balance"}',
    );
    expect(
      formatAssistantErrorText(msg, { provider: "openai-compatible", model: "custom-model" }),
    ).toBe(formatBillingErrorMessage("openai-compatible", "custom-model"));
  });

  it("surfaces provider-specific rate limit message from JSON payload (#54433)", () => {
    const msg = makeAssistantError(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached. Try again in 30 seconds."}}',
    );
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("30 seconds");
    expect(result).not.toBe(
      "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    );
    expect(formatUserFacingAssistantErrorText(msg)).toContain("30 seconds");
  });

  it("uses structured transport codes with a generic provider message", () => {
    expectBothCopies(
      { ...makeAssistantError("Connection error."), errorCode: "ENOTFOUND" },
      "Couldn't connect to the AI service. Check your connection, then try again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    );
  });

  it("returns a friendly disk-space message", () => {
    expectCopy(
      "ENOSPC: no space left on device, write",
      "OpenClaw could not write local session data because the disk is full. Free some disk space and try again.",
    );
  });

  it("returns a missing-scope message for raw OpenAI ChatGPT scope payloads without an HTTP prefix", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write model.request"},"code":401}',
    );
    expect(formatAssistantErrorText(msg, { provider: "openai" })).toBe(
      "This login doesn't have the access OpenClaw needs. Sign in again under Models in the Control UI.",
    );
  });

  it("sanitizes raw HTTP 401 / Invalid token errors into a re-auth hint (#56197)", () => {
    const reportedPayload = makeAssistantError('HTTP 401: "Invalid token"');
    const friendly = formatAssistantErrorText(reportedPayload);
    expect(friendly).toBe(authInvalidTokenCopy);
    expect(friendly).not.toContain("Invalid token");
  });

  it("uses structured error body detail for model-not-found copy", () => {
    const msg = makeAssistantMessageFixture({
      errorMessage: "400 Param Incorrect",
      errorCode: "400",
      errorBody:
        '{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}',
      content: [],
    });

    expectBothCopies(msg, "This model was not found. Choose another model in the Control UI.");
  });
});

it("truncates fallback raw error text on UTF-16 code-point boundary without dangling surrogates", () => {
  const prefix = "x".repeat(599);
  expect(formatRawAssistantErrorForUi(`${prefix}🎉`)).toBe(`${prefix}…`);
});

it("recognizes provider-prefixed JSON payloads for observation fingerprints", () => {
  const raw =
    'Ollama API error: {"type":"error","error":{"type":"server_error","message":"Boom"},"request_id":"req_123"}';

  expect(isRawApiErrorPayload(raw)).toBe(true);
  expect(getApiErrorPayloadFingerprint(raw)).toBe(
    '{"error":{"message":"Boom","type":"server_error"},"request_id":"req_123","type":"error"}',
  );
});

it("returns neutral copy for token authMode — no 'API key' text", () => {
  const result = formatBillingErrorMessage("Anthropic", "claude-sonnet-4-5", "token");
  expect(result).not.toMatch(/api key/i);
  expect(result).not.toMatch(/top up/i);
  expect(result).toContain("check your account");
});

it("rewrites transport-classified malformed streaming fragments in error context", () => {
  const result = renderUserFacingText(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, {
    errorContext: true,
  });
  expect(result).toBe("LLM streaming response contained a malformed fragment. Please try again.");
});
