import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatAssistantErrorText,
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
  it("includes provider name in billing message when provider is given", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg, { provider: "Anthropic" });
    expect(result).toBe(formatBillingErrorMessage("Anthropic"));
    expect(result).toContain("Anthropic");
    expect(result).not.toContain("API provider");
  });
  it("returns generic billing message when provider is not given", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("API provider");
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
});
