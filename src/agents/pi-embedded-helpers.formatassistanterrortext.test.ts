import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
  isJsonParseError,
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

  it("returns a friendly message for empty stream chunk errors", () => {
    const msg = makeAssistantError("request ended without sending any chunks");
    expect(formatAssistantErrorText(msg)).toBe("LLM request timed out.");
  });

  it("returns a friendly message for JSON parse errors from SSE stream corruption", () => {
    const msg = makeAssistantError(
      "Bad control character in string literal in JSON at position 144 (line 1 column 145)",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service returned a malformed response. Please try again.",
    );
  });

  it("returns a friendly message for 'Expected' JSON parse errors", () => {
    const msg = makeAssistantError(
      "Expected ':' after property name in JSON at position 87 (line 1 column 88)",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service returned a malformed response. Please try again.",
    );
  });

  it("returns a friendly message for 'Unexpected end of JSON input'", () => {
    const msg = makeAssistantError("Unexpected end of JSON input");
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service returned a malformed response. Please try again.",
    );
  });

  it("never returns raw unclassified error text to users", () => {
    const msg = makeAssistantError("some completely unknown error that no pattern matches");
    const result = formatAssistantErrorText(msg);
    expect(result).not.toContain("some completely unknown error");
    expect(result).toBe("An unexpected error occurred. Please try again.");
  });

  it("never leaks long raw error text to users", () => {
    const msg = makeAssistantError("x".repeat(1000));
    const result = formatAssistantErrorText(msg);
    expect(result.length).toBeLessThan(100);
    expect(result).toBe("An unexpected error occurred. Please try again.");
  });
});

  it("detects 'Unterminated' string errors", () => {
    expect(isJsonParseError("Unterminated string in JSON at position 42")).toBe(true);
  });

  it("detects 'Unexpected end of JSON input'", () => {
    expect(isJsonParseError("Unexpected end of JSON input")).toBe(true);
  });
        "Bad control character in string literal in JSON at position 144 (line 1 column 145)",
      ),
    ).toBe(true);
  });

  it("detects 'Expected' errors", () => {
    expect(
      isJsonParseError(
        "Expected ',' or '}' after property value in JSON at position 91 (line 1 column 92)",
      ),
    ).toBe(true);
  });

  it("detects 'Unexpected' token errors", () => {
    expect(isJsonParseError("Unexpected token < in JSON at position 0")).toBe(true);
  });

  it("detects 'Unterminated' string errors", () => {
    expect(isJsonParseError("Unterminated string in JSON at position 42")).toBe(true);
  });

  it("detects SyntaxError wrapping", () => {
    expect(isJsonParseError("SyntaxError: Unexpected token in JSON")).toBe(true);
  });

  it("returns false for empty input", () => {
    expect(isJsonParseError("")).toBe(false);
  });

  it("returns false for non-JSON errors", () => {
    expect(isJsonParseError("Connection refused")).toBe(false);
    expect(isJsonParseError("rate limit exceeded")).toBe(false);
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
