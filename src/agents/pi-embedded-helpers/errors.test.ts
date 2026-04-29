import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { formatAssistantErrorText } from "./errors.js";

describe("formatAssistantErrorText streaming JSON parse classification", () => {
  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    makeAssistantMessageFixture({
      errorMessage,
      content: [{ type: "text", text: errorMessage }],
    });

  it("suppresses raw streaming tool-call fragment parse failures", () => {
    const msg = makeAssistantError(
      "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM streaming response contained a malformed fragment. Please try again.",
    );
  });

  it.each([
    "Unexpected end of JSON input",
    "Unexpected non-whitespace character after JSON at position 4",
  ])("suppresses plain JSON.parse streaming fragment failures: %s", (errorMessage) => {
    const msg = makeAssistantError(errorMessage);
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM streaming response contained a malformed fragment. Please try again.",
    );
  });

  it("suppresses structured Anthropic tool-call delta parse failures", () => {
    const msg = makeAssistantError(
      'Could not parse Anthropic SSE event content_block_delta: Unexpected end of JSON input; data={"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"},"index":0}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM streaming response contained a malformed fragment. Please try again.",
    );
  });

  it("keeps non-streaming provider request-validation syntax diagnostics", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Expected value in JSON at position 12 for messages.0.content"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request rejected: Expected value in JSON at position 12 for messages.0.content",
    );
  });
});
