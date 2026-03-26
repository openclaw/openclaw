import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatAssistantErrorText,
  getApiErrorPayloadFingerprint,
  formatRawAssistantErrorForUi,
  isRawApiErrorPayload,
} from "./pi-embedded-helpers.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

describe("formatAssistantErrorText", () => {
  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    makeAssistantMessageFixture({
      errorMessage,
      content: [{ type: "text", text: errorMessage }],
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
  it("returns context overflow for Kimi 'model token limit' errors", () => {
    const msg = makeAssistantError(
      "error, status code: 400, message: Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
    );
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns context overflow for Ollama 'prompt too long' errors (#34005)", () => {
    const msg = makeAssistantError(
      'Ollama API error 400: {"StatusCode":400,"Status":"400 Bad Request","error":"prompt too long; exceeded max context length by 4 tokens"}',
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
  it("suppresses raw error JSON payloads that are not otherwise classified", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"message":"Something exploded","type":"server_error"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe("LLM error server_error: Something exploded");
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

  it("surfaces provider-specific rate limit message with reset time (#54433)", () => {
    const msg = makeAssistantError(
      "You have hit your ChatGPT usage limit (go plan). Try again in ~4381 min.",
    );
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("4381 min");
    expect(result).toContain("go plan");
    expect(result).not.toBe("⚠️ API rate limit reached. Please try again later.");
  });

  it("surfaces provider-specific rate limit message from JSON payload (#54433)", () => {
    const msg = makeAssistantError(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached. Try again in 30 seconds."}}',
    );
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("30 seconds");
    expect(result).not.toBe("⚠️ API rate limit reached. Please try again later.");
  });

  it("returns generic rate limit message when no specific details are present", () => {
    const msg = makeAssistantError("429 Too Many Requests");
    expect(formatAssistantErrorText(msg)).toBe(
      "⚠️ API rate limit reached. Please try again later.",
    );
  });

  it("strips leading HTTP status code prefix from non-JSON rate limit messages", () => {
    const msg = makeAssistantError("429 Your quota has been exhausted, try again in 24 hours");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("try again in 24 hours");
    expect(result).not.toMatch(/^⚠️ 429\b/);
    expect(result).toBe("⚠️ Your quota has been exhausted, try again in 24 hours");
  });

  it("falls back to generic copy for HTML quota pages", () => {
    const msg = makeAssistantError(
      "429 <!DOCTYPE html><html><body>Your quota is exhausted</body></html>",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "⚠️ API rate limit reached. Please try again later.",
    );
  });

  it("falls back to generic copy for prefixed HTML rate-limit pages", () => {
    const msg = makeAssistantError(
      "Error: 521 <!DOCTYPE html><html><body>rate limit</body></html>",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "⚠️ API rate limit reached. Please try again later.",
    );
  });

  it("returns a friendly message for empty stream chunk errors", () => {
    const msg = makeAssistantError("request ended without sending any chunks");
    expect(formatAssistantErrorText(msg)).toBe("LLM request timed out.");
  });

  it("returns a connection-refused message for ECONNREFUSED failures", () => {
    const msg = makeAssistantError("connect ECONNREFUSED 127.0.0.1:443 during upstream call");
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request failed: connection refused by the provider endpoint.",
    );
  });

  it("returns a DNS-specific message for provider lookup failures", () => {
    const msg = makeAssistantError("dial tcp: lookup api.example.com: no such host (ENOTFOUND)");
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request failed: DNS lookup for the provider endpoint failed.",
    );
  });

  it("returns an interrupted-connection message for socket hang ups", () => {
    const msg = makeAssistantError("socket hang up");
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request failed: network connection was interrupted.",
    );
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

  it("formats plain HTTP status lines", () => {
    expect(formatRawAssistantErrorForUi("500 Internal Server Error")).toBe(
      "HTTP 500: Internal Server Error",
    );
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
});

describe("raw API error payload helpers", () => {
  it("recognizes provider-prefixed JSON payloads for observation fingerprints", () => {
    const raw =
      'Ollama API error: {"type":"error","error":{"type":"server_error","message":"Boom"},"request_id":"req_123"}';

    expect(isRawApiErrorPayload(raw)).toBe(true);
    expect(getApiErrorPayloadFingerprint(raw)).toContain("server_error");
    expect(getApiErrorPayloadFingerprint(raw)).toContain("req_123");
  });
});
