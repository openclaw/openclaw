// Covers user-facing formatting and sanitization of assistant/provider errors.
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

  it.each([
    [
      "Selected model is at capacity. Please try a different model.",
      "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
    ],
    [
      'Codex error: {"type":"error","error":{"message":"Something exploded","type":"server_error"},"sequence_number":2}',
      "LLM error server_error: Something exploded",
    ],
    [
      `<!DOCTYPE html>
<html>
  <head>
    <title>Just a moment...</title>
    <link rel="dns-prefetch" href="//chatgpt.com">
  </head>
  <body>
    <span id="challenge-error-text">Enable JavaScript and cookies to continue</span>
    <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
  </body>
</html>`,
      "Couldn't reach the AI service. Try again in a moment. If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    ],
    ["request ended without sending any chunks", "LLM request timed out."],
    [
      "file lock timeout for /tmp/openclaw-oauth-refresh.lock",
      "Another sign-in is still in progress. Wait a moment, then try again.",
    ],
    [
      "403 <!DOCTYPE html><html><body>Access denied</body></html>",
      "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
    ],
    [
      "407 Proxy Authentication Required",
      "Couldn't connect to the AI service. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    ],
    [
      "Hostname/IP does not match certificate's altnames: Host: api.example.com",
      "Couldn't connect securely to the AI service. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    ],
  ])("formats assistant error: %s", (raw, expected) => {
    expect(formatAssistantErrorText(makeAssistantError(raw))).toBe(expected);
  });

  it("keeps plain HTTP rate-limit guidance user-facing", () => {
    const msg = makeAssistantError("429 Your quota has been exhausted, try again in 24 hours");
    expect(formatAssistantErrorText(msg)).toBe(
      "⚠️ Your quota has been exhausted, try again in 24 hours",
    );
    expect(formatUserFacingAssistantErrorText(msg)).toContain("24 hours");
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
    // This Anthropic shape must map to context overflow so auto-compaction can
    // trigger instead of treating it as a generic schema rejection.
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
    {
      title: "returns a friendly message for Anthropic overload errors",
      errorText:
        '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_123"}',
      expected: "The AI service is temporarily overloaded. Please try again in a moment.",
    },
    {
      title: "uses classified rate-limit copy for Z.AI rate-limit errors",
      errorText:
        '429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}',
      expected: "⚠️ The AI service needs a short break. Please try again in a few minutes.",
    },
    {
      title: "rewrites generic provider internal errors without support request ids",
      errorText:
        "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID synthetic-provider-request-001 in your message.",
      expected: "The AI service returned an internal error. Please try again in a moment.",
    },
    {
      title: "returns upstream HTML copy for prefixed 521 HTML rate-limit pages",
      errorText: "Error: 521 <!DOCTYPE html><html><body>rate limit</body></html>",
      expected:
        "Couldn't reach the AI service. Try again in a moment. If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    },
    {
      title: "returns an explicit re-authentication message for OAuth refresh failures",
      errorText:
        "OAuth token refresh failed for openai: invalid_grant. Please try again or re-authenticate.",
      expected:
        "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
    },
    {
      title: "returns re-authentication guidance after an account switch",
      errorText:
        "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      expected:
        "Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
    },
    {
      title: "returns a timeout-specific message for OAuth refresh hard timeouts",
      errorText:
        'OAuth refresh call "refreshProviderOAuthCredentialWithPlugin(openai)" exceeded hard timeout (120000ms)',
      expected:
        "Signing in took too long. Try again in a moment. If it keeps happening, sign in again under Models in the Control UI.",
    },
    {
      title: "sanitizes invalid streaming event order errors",
      errorText: 'Unexpected event order, got message_start before receiving "message_stop"',
      expected:
        "LLM request failed: provider returned an invalid streaming response. Please try again.",
    },
  ])("$title", ({ errorText, expected }) => {
    const msg = makeAssistantError(errorText);
    expect(formatAssistantErrorText(msg)).toBe(expected);
  });
  it("returns a recovery hint when tool call input is missing", () => {
    const msg = makeAssistantError("tool_use.input: Field required");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Session history looks corrupted");
    expect(result).toContain("/new");
  });
  it("prioritizes thinking-signature replay recovery over invalid-request formatting", () => {
    // Thinking-signature failures are also invalid_request_error, so the
    // replay-invalid copy must win before the generic invalid-request path.
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
    );
    const replayCopy =
      "Session history or replay state is invalid. Use /new to start a fresh session and try again.";
    expect(formatAssistantErrorText(msg)).toBe(replayCopy);
    expect(formatUserFacingAssistantErrorText(msg)).toBe(replayCopy);
  });
  it("handles JSON-wrapped role errors", () => {
    const msg = makeAssistantError('{"error":{"message":"400 Incorrect role information"}}');
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Message ordering conflict");
    expect(result).not.toContain("400");
  });
  it.each([{ prepared: false }])(
    "replaces raw provider detail with classified facts (prepared: $prepared)",
    ({ prepared }) => {
      const raw = "HTTP 500: opaque-provider-canary";
      const userFacing = formatUserFacingAssistantErrorText(makeAssistantError(raw), {
        provider: "openai",
        providerOwner: prepared
          ? {
              id: "openai",
              classifyFailoverReason: () => "server_error",
            }
          : undefined,
        model: "gpt-5.6-luna",
      });

      expect(userFacing).toBe("⚠️ The AI service is having trouble. Please try again in a moment.");
      expect(userFacing).not.toContain("opaque-provider-canary");
    },
  );

  it.each(["opaque-private-provider-detail"])(
    "points unclassified failures to diagnostics: %s",
    (raw) => {
      expect(
        formatUserFacingAssistantErrorText(makeAssistantError(raw), {
          provider: "openai",
          model: "test-model",
        }),
      ).toBe(
        "⚠️ OpenClaw couldn't finish this reply. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
      );
    },
  );

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
  it("renders opaque upstream_error facts as a temporary provider error", () => {
    const msg = makeAssistantMessageFixture({
      provider: "openai",
      model: "gpt-5.6-luna",
      errorMessage: "opaque provider response",
      errorType: "upstream_error",
    });

    expect(formatUserFacingAssistantErrorText(msg)).toBe(
      "⚠️ The AI service is having trouble. Please try again in a moment.",
    );
  });
  it("uses generic user-facing copy for escaped structured provider messages", () => {
    // The internal formatter keeps detail for logs, while user-facing text must
    // not expose arbitrary provider-controlled structured payload content.
    const msg = makeAssistantError(
      '{"type":"error","error":{"message":"SECRET\\nCANARY","type":"invalid_request_error"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe("LLM request rejected: SECRET\nCANARY");
    expect(formatUserFacingAssistantErrorText(msg)).toBe(
      "The AI service couldn't accept this request. Try a new conversation with /new, or choose another model in the Control UI.",
    );
  });
  it("surfaces allowlisted token limits from structured provider messages", () => {
    const msg = makeAssistantError(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "max_tokens (384000) exceeds model's maximum output tokens (65536) for model deepseek-v4-flash:0731",
        },
      }),
    );

    const userFacing = formatUserFacingAssistantErrorText(msg);
    expect(userFacing).toBe(
      "The reply length is set too high for this model. Lower its reply limit in the Control UI settings, or choose another model.",
    );
    expect(userFacing).not.toContain("deepseek-v4-flash:0731");
  });

  it("surfaces token limits from structured error bodies", () => {
    const msg = makeAssistantMessageFixture({
      errorMessage: "400 Param Incorrect",
      errorCode: "400",
      errorBody: JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "max_tokens (384000) exceeds model's maximum output tokens (65536) for model deepseek-v4-flash:0731",
        },
      }),
      content: [],
    });

    const userFacing = formatUserFacingAssistantErrorText(msg);
    expect(userFacing).toBe(
      "The reply length is set too high for this model. Lower its reply limit in the Control UI settings, or choose another model.",
    );
    expect(userFacing).not.toContain("deepseek-v4-flash:0731");
  });

  it.each([
    "Error: OpenAI API error (400): max_tokens (384000) exceeds model's maximum output tokens (65536)",
  ])("surfaces token limits from provider-wrapped HTTP error %s", (raw) => {
    const msg = makeAssistantError(raw);
    expect(formatAssistantErrorText(msg)).toBe(
      "The reply length is set too high for this model. Lower its reply limit in the Control UI settings, or choose another model.",
    );
    expect(formatUserFacingAssistantErrorText(msg)).toBe(
      "The reply length is set too high for this model. Lower its reply limit in the Control UI settings, or choose another model.",
    );
  });
  it("returns a friendly billing message for HTTP 402 errors", () => {
    const msg = makeAssistantError("HTTP 402 Payment Required");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("uses prepared provider ownership for billing classification", () => {
    const provider = "custom-openrouter";
    const model = "anthropic/claude-sonnet-4";
    const result = formatAssistantErrorText(
      makeAssistantError("HTTP 403: API key budget limit exceeded"),
      {
        provider,
        providerOwner: {
          id: "openrouter",
          classifyFailoverReason: ({ provider: owner, errorMessage }) =>
            owner === "openrouter" && errorMessage.includes("budget limit") ? "billing" : undefined,
        },
        model,
      },
    );
    expect(result).toBe(formatBillingErrorMessage(provider, model));
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

  it("does not rewrite Provider finish_reason: error into a timeout (#109218)", () => {
    const msg = makeAssistantError("Provider finish_reason: error");
    // Keep provider signal; do not rewrite to the timeout string (formatAssistantErrorText
    // may return undefined for some paths — assert the concrete copy we preserve).
    expect(formatAssistantErrorText(msg)).toBe("Provider finish_reason: error");
  });

  it.each([
    [
      "ENOTFOUND",
      "Couldn't connect to the AI service. Check your connection, then try again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    ],
    [
      "UNRECOGNIZED",
      "Couldn't connect to the AI service. Check your connection, then try again. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.",
    ],
  ])("uses structured transport code %s with a generic provider message", (errorCode, expected) => {
    const message = { ...makeAssistantError("Connection error."), errorCode };
    expect(formatAssistantErrorText(message)).toBe(expected);
    expect(formatUserFacingAssistantErrorText(message)).toBe(expected);
  });

  it.each(["ENOSPC: no space left on device, write"])(
    "returns a friendly disk-space message for %s",
    (errorMessage) => {
      const msg = makeAssistantError(errorMessage);
      expect(formatAssistantErrorText(msg)).toBe(
        "OpenClaw could not write local session data because the disk is full. Free some disk space and try again.",
      );
    },
  );

  it("returns a missing-scope message for raw OpenAI ChatGPT scope payloads without an HTTP prefix", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write model.request"},"code":401}',
    );
    expect(formatAssistantErrorText(msg, { provider: "openai" })).toBe(
      "This login doesn't have the access OpenClaw needs. Sign in again under Models in the Control UI.",
    );
  });

  it("does not misdiagnose generic OpenAI permission failures as missing-scope failures", () => {
    const msg = makeAssistantError(
      '403 {"type":"error","error":{"type":"permission_error","message":"Insufficient permissions for this organization"}}',
    );
    expect(formatAssistantErrorText(msg, { provider: "openai" })).not.toContain(
      "required OpenAI ChatGPT scopes",
    );
  });

  it("sanitizes raw HTTP 401 / Invalid token errors into a re-auth hint (#56197)", () => {
    const reportedPayload = makeAssistantError('HTTP 401: "Invalid token"');
    const friendly = formatAssistantErrorText(reportedPayload);
    expect(friendly).toBe(authInvalidTokenCopy);
    expect(friendly).not.toContain("Invalid token");
  });

  it("does not claim HTTP 401 for message-only auth errors with no HTTP status prefix (#77394 review)", () => {
    const messageOnly = makeAssistantError('{"error":{"code":"invalid_api_key"}}');
    const friendly = formatAssistantErrorText(messageOnly);
    expect(friendly).toBeDefined();
    expect(friendly).not.toContain("HTTP 401");
    expect(friendly).not.toBe(authInvalidTokenCopy);
  });

  it("does not rewrite provider-less missing-scope 401 payloads as invalid-token errors", () => {
    const raw =
      '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}';
    const missingScope = makeAssistantMessageFixture({
      provider: undefined,
      errorMessage: raw,
      content: [{ type: "text", text: raw }],
    });
    const friendly = formatAssistantErrorText(missingScope);
    expect(friendly).not.toBe(authInvalidTokenCopy);
    expect(friendly).toContain("permission_error");
  });

  it("uses structured error body detail for model-not-found copy", () => {
    const msg = makeAssistantMessageFixture({
      errorMessage: "400 Param Incorrect",
      errorCode: "400",
      errorBody:
        '{"code":"400","message":"Param Incorrect","param":"Not supported model some-model-id"}',
      content: [],
    });

    expect(formatAssistantErrorText(msg)).toBe(
      "This model was not found. Choose another model in the Control UI.",
    );
    expect(formatUserFacingAssistantErrorText(msg)).toBe(
      "This model was not found. Choose another model in the Control UI.",
    );
  });
});

describe("formatRawAssistantErrorForUi", () => {
  it("truncates fallback raw error text on UTF-16 code-point boundary without dangling surrogates", () => {
    const prefix = "x".repeat(599);
    expect(formatRawAssistantErrorForUi(`${prefix}🎉`)).toBe(`${prefix}…`);
  });
});

describe("raw API error payload helpers", () => {
  it("recognizes provider-prefixed JSON payloads for observation fingerprints", () => {
    const raw =
      'Ollama API error: {"type":"error","error":{"type":"server_error","message":"Boom"},"request_id":"req_123"}';

    expect(isRawApiErrorPayload(raw)).toBe(true);
    expect(getApiErrorPayloadFingerprint(raw)).toBe(
      '{"error":{"message":"Boom","type":"server_error"},"request_id":"req_123","type":"error"}',
    );
  });
});

describe("formatBillingErrorMessage — authMode neutral copy (#80877)", () => {
  // OAuth/Max users should NOT see "API key" or "top up" language.
  it("returns neutral copy for oauth authMode — no 'API key' text", () => {
    const result = formatBillingErrorMessage("Anthropic", "claude-sonnet-4-5", "oauth");
    expect(result).not.toMatch(/api key/i);
    expect(result).not.toMatch(/top up/i);
    expect(result).toContain("check your account");
  });

  it("returns neutral copy for token authMode — no 'API key' text", () => {
    const result = formatBillingErrorMessage("Anthropic", "claude-sonnet-4-5", "token");
    expect(result).not.toMatch(/api key/i);
    expect(result).not.toMatch(/top up/i);
  });
});

describe("sanitizeUserFacingText — streaming JSON parse error (#59076)", () => {
  it("rewrites transport-classified malformed streaming fragments in error context", () => {
    const result = renderUserFacingText(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, {
      errorContext: true,
    });
    expect(result).toBe("LLM streaming response contained a malformed fragment. Please try again.");
  });
});
