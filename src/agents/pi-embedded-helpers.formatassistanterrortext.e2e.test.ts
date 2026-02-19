import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  AUTH_CONFIG_ERROR_MESSAGE,
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
} from "./pi-embedded-helpers.js";

describe("formatAssistantErrorText", () => {
  const makeAssistantError = (errorMessage: string): AssistantMessage => ({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "error",
    errorMessage,
    content: [{ type: "text", text: errorMessage }],
    timestamp: 0,
  });

  it("returns a friendly message for context overflow", () => {
    const msg = makeAssistantError("request_too_large");
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns context overflow for Anthropic 'Request size exceeds model context window'", () => {
    // This is the new Anthropic error format that wasn't being detected.
    // Without the fix, this falls through to the invalidRequest regex and returns
    // "LLM request rejected: Request size exceeds model context window"
    // instead of the context overflow message, preventing auto-compaction.
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
    );
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns a friendly message for Anthropic role ordering", () => {
    const msg = makeAssistantError('messages: roles must alternate between "user" and "assistant"');
    expect(formatAssistantErrorText(msg)).toContain("Message ordering conflict");
  });
  it("returns a friendly message for Anthropic overload errors", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_123"}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
  });
  it("returns a recovery hint when tool call input is missing", () => {
    const msg = makeAssistantError("tool_use.input: Field required");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Session history looks corrupted");
    expect(result).toContain("/new");
  });
  it("handles JSON-wrapped role errors", () => {
    const msg = makeAssistantError('{"error":{"message":"400 Incorrect role information"}}');
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Message ordering conflict");
    expect(result).not.toContain("400");
  });
  it("suppresses raw transient server error JSON payloads with a friendly message", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"message":"Something exploded","type":"server_error"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service encountered a temporary error. Please try again in a moment.",
    );
  });
  it("suppresses Anthropic api_error with Internal server error (the original leak bug)", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CYFmpt8r8CFFmnpgGL5cQ"}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service encountered a temporary error. Please try again in a moment.",
    );
  });
  it("suppresses 'service temporarily unavailable' messages as transient errors", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"api_error","message":"Service temporarily unavailable"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service encountered a temporary error. Please try again in a moment.",
    );
  });
  it("suppresses exact 'an error occurred' messages as transient errors", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"api_error","message":"An error occurred"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service encountered a temporary error. Please try again in a moment.",
    );
  });
  it("does NOT suppress 'an error occurred' when part of a longer actionable message", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"An error occurred while validating: missing field \'model\'"}}',
    );
    const result = formatAssistantErrorText(msg);
    expect(result).not.toBe(
      "The AI service encountered a temporary error. Please try again in a moment.",
    );
  });
  it("uses httpCode fallback to treat 5xx API errors as transient", () => {
    const msg = makeAssistantError(
      '503 {"type":"error","error":{"type":"unknown_type","message":"Upstream failure"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service encountered a temporary error. Please try again in a moment.",
    );
  });
  it("returns a friendly billing message for credit balance errors", () => {
    const msg = makeAssistantError("Your credit balance is too low to access the Anthropic API.");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("returns a friendly billing message for HTTP 402 errors", () => {
    const msg = makeAssistantError("HTTP 402 Payment Required");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("returns a friendly billing message for insufficient credits", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("includes provider and assistant model in billing message when provider is given", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg, { provider: "Anthropic" });
    expect(result).toBe(formatBillingErrorMessage("Anthropic", "test-model"));
    expect(result).toContain("Anthropic");
    expect(result).not.toContain("API provider");
  });
  it("uses the active assistant model for billing message context", () => {
    const msg = makeAssistantError("insufficient credits");
    msg.model = "claude-3-5-sonnet";
    const result = formatAssistantErrorText(msg, { provider: "Anthropic" });
    expect(result).toBe(formatBillingErrorMessage("Anthropic", "claude-3-5-sonnet"));
  });
  it("returns generic billing message when provider is not given", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("API provider");
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("returns a friendly message for rate limit errors", () => {
    const msg = makeAssistantError("429 rate limit reached");
    expect(formatAssistantErrorText(msg)).toContain("rate limit reached");
  });

  it("returns a friendly message for empty stream chunk errors", () => {
    const msg = makeAssistantError("request ended without sending any chunks");
    expect(formatAssistantErrorText(msg)).toBe("LLM request timed out.");
  });

  // --- Auth / permission error suppression ---
  it("suppresses 401 authentication_error JSON payloads", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_abc"}',
    );
    expect(formatAssistantErrorText(msg)).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });
  it("suppresses permission_error JSON payloads", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission"},"request_id":"req_xyz"}',
    );
    expect(formatAssistantErrorText(msg)).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });
  it("suppresses plain auth error messages (unauthorized, invalid api key)", () => {
    const msg = makeAssistantError("unauthorized");
    expect(formatAssistantErrorText(msg)).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });

  // --- Failover wrapper suppression ---
  it("suppresses FailoverError wrapper messages", () => {
    const msg = makeAssistantError("FailoverError: HTTP 401 authentication_error");
    expect(formatAssistantErrorText(msg)).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });
  it("suppresses 'All models failed' wrapper messages", () => {
    const msg = makeAssistantError(
      "All models failed (3): anthropic/claude-opus-4-5: rate limit | openai/gpt-4.1: timeout | google/gemini-2.5-pro: auth",
    );
    expect(formatAssistantErrorText(msg)).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });
});

describe("formatRawAssistantErrorForUi", () => {
  it("renders HTTP code + type + message from Anthropic payloads", () => {
    const text = formatRawAssistantErrorForUi(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited."},"request_id":"req_123"}',
    );

    expect(text).toContain("HTTP 429");
    expect(text).toContain("rate_limit_error");
    expect(text).toContain("Rate limited.");
    expect(text).toContain("req_123");
  });

  it("renders a generic unknown error message when raw is empty", () => {
    expect(formatRawAssistantErrorForUi("")).toContain("unknown error");
  });

  it("suppresses plain transient HTTP 500 status lines", () => {
    expect(formatRawAssistantErrorForUi("500 Internal Server Error")).toBe(
      "The AI service encountered a temporary error. Please try again in a moment.",
    );
  });
  it("formats plain non-transient HTTP status lines", () => {
    expect(formatRawAssistantErrorForUi("400 Bad Request")).toBe("HTTP 400: Bad Request");
  });

  it("sanitizes HTML error pages into a clean unavailable message", () => {
    const htmlError = `521 <!DOCTYPE html>
<html lang="en-US">
  <head><title>Web server is down | example.com | Cloudflare</title></head>
  <body>Ray ID: abc123</body>
</html>`;

    expect(formatRawAssistantErrorForUi(htmlError)).toBe(
      "The AI service is temporarily unavailable (HTTP 521). Please try again in a moment.",
    );
  });

  it("suppresses authentication_error JSON payloads", () => {
    expect(
      formatRawAssistantErrorForUi(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      ),
    ).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });

  it("suppresses plain HTTP 401 status lines", () => {
    expect(formatRawAssistantErrorForUi("401 Unauthorized")).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });

  it("suppresses plain HTTP 403 status lines", () => {
    expect(formatRawAssistantErrorForUi("403 Forbidden")).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });

  it("strips FailoverError wrapper and sanitizes inner error", () => {
    expect(formatRawAssistantErrorForUi("FailoverError: HTTP 401 authentication_error")).toBe(
      AUTH_CONFIG_ERROR_MESSAGE,
    );
  });

  it("strips 'All models failed' wrapper and returns safe message", () => {
    expect(
      formatRawAssistantErrorForUi(
        "All models failed (2): anthropic/claude-opus-4-5: 401 | openai/gpt-4.1: 429",
      ),
    ).toBe(AUTH_CONFIG_ERROR_MESSAGE);
  });
});
