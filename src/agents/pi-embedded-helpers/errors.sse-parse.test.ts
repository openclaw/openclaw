import { describe, expect, it } from "vitest";
import { isLikelySSEParseError } from "../pi-embedded-helpers.js";

const STREAMING_STACK =
  "SyntaxError: Unexpected end of JSON input\n" +
  "    at JSON.parse (<anonymous>)\n" +
  "    at Stream._fromSSEResponse (node_modules/@anthropic-ai/sdk/streaming.js:45:12)";

const NON_STREAMING_STACK =
  "SyntaxError: Unexpected end of JSON input\n" +
  "    at JSON.parse (<anonymous>)\n" +
  "    at parseToolResult (src/tools/parser.js:42:20)";

describe("isLikelySSEParseError", () => {
  it("returns false for undefined/empty input", () => {
    expect(isLikelySSEParseError(undefined)).toBe(false);
    expect(isLikelySSEParseError("")).toBe(false);
  });

  // With streaming stack: generic JSON errors should match
  it("detects SyntaxError + JSON context with streaming stack", () => {
    expect(
      isLikelySSEParseError("SyntaxError: Unexpected end of JSON input", STREAMING_STACK),
    ).toBe(true);
    expect(
      isLikelySSEParseError(
        "SyntaxError: Unexpected token < in JSON at position 0",
        STREAMING_STACK,
      ),
    ).toBe(true);
  });

  // Without stack: only matches when message itself mentions SSE/stream
  it("detects SyntaxError + JSON + SSE/stream keyword in message (no stack)", () => {
    expect(isLikelySSEParseError("Syntax error while parsing SSE stream JSON data")).toBe(true);
    expect(isLikelySSEParseError("SyntaxError: Unexpected end of JSON input from SSE stream")).toBe(
      true,
    );
    expect(
      isLikelySSEParseError("SyntaxError: Unexpected token < in JSON at position 0 (stream)"),
    ).toBe(true);
  });

  it("rejects generic JSON errors without stack or streaming keyword", () => {
    expect(isLikelySSEParseError("SyntaxError: Unexpected end of JSON input")).toBe(false);
    expect(isLikelySSEParseError("Unexpected end of JSON input")).toBe(false);
    expect(isLikelySSEParseError("Unexpected token } in JSON at position 42")).toBe(false);
    expect(isLikelySSEParseError("Unterminated string in JSON at position 100")).toBe(false);
    expect(
      isLikelySSEParseError("Bad control character in string literal in JSON at position 5"),
    ).toBe(false);
    expect(
      isLikelySSEParseError("Expected double-quoted property name in JSON at position 12"),
    ).toBe(false);
    expect(
      isLikelySSEParseError("Expected ',' or '}' after property value in JSON at position 50"),
    ).toBe(false);
  });

  it("matches generic JSON errors with streaming stack", () => {
    expect(isLikelySSEParseError("Unexpected end of JSON input", STREAMING_STACK)).toBe(true);
    expect(
      isLikelySSEParseError("Unexpected token } in JSON at position 42", STREAMING_STACK),
    ).toBe(true);
    expect(
      isLikelySSEParseError("Unterminated string in JSON at position 100", STREAMING_STACK),
    ).toBe(true);
    expect(
      isLikelySSEParseError(
        "Bad control character in string literal in JSON at position 5",
        STREAMING_STACK,
      ),
    ).toBe(true);
    expect(
      isLikelySSEParseError(
        "Expected double-quoted property name in JSON at position 12",
        STREAMING_STACK,
      ),
    ).toBe(true);
    expect(
      isLikelySSEParseError(
        "Expected ',' or '}' after property value in JSON at position 50",
        STREAMING_STACK,
      ),
    ).toBe(true);
  });

  it("rejects generic JSON errors with non-streaming stack", () => {
    expect(
      isLikelySSEParseError("SyntaxError: Unexpected end of JSON input", NON_STREAMING_STACK),
    ).toBe(false);
    expect(isLikelySSEParseError("Unexpected end of JSON input", NON_STREAMING_STACK)).toBe(false);
  });

  // Anthropic SDK SSE-specific patterns: always match regardless of stack
  it("detects Anthropic SDK SSE-specific patterns", () => {
    expect(isLikelySSEParseError("Could not parse SSE event")).toBe(true);
    expect(isLikelySSEParseError("Failed to parse SSE data")).toBe(true);
    expect(isLikelySSEParseError("malformed SSE event from proxy")).toBe(true);
  });

  it("detects Anthropic SDK patterns even with non-streaming stack", () => {
    expect(isLikelySSEParseError("Could not parse SSE event", NON_STREAMING_STACK)).toBe(true);
  });

  it("does not match context overflow errors", () => {
    expect(isLikelySSEParseError("context length exceeded")).toBe(false);
    expect(isLikelySSEParseError("request_too_large")).toBe(false);
    expect(isLikelySSEParseError("prompt is too long")).toBe(false);
  });

  it("does not match rate limit errors", () => {
    expect(isLikelySSEParseError("rate limit exceeded")).toBe(false);
    expect(isLikelySSEParseError("too many requests")).toBe(false);
  });

  it("does not match billing errors", () => {
    expect(isLikelySSEParseError("insufficient credits")).toBe(false);
    expect(isLikelySSEParseError("payment required")).toBe(false);
  });

  it("does not match generic non-JSON errors", () => {
    expect(isLikelySSEParseError("connection reset by peer")).toBe(false);
    expect(isLikelySSEParseError("ECONNREFUSED")).toBe(false);
    expect(isLikelySSEParseError("timeout")).toBe(false);
  });

  it("matches real-world Azure proxy truncation error with streaming stack", () => {
    expect(
      isLikelySSEParseError(
        "SyntaxError: Expected double-quoted property name in JSON at position 83 (line 1 column 84)",
        STREAMING_STACK,
      ),
    ).toBe(true);
  });

  // Stack trace validation
  describe("stack trace narrowing", () => {
    const sseMessage = "SyntaxError: Unexpected end of JSON input";

    it("matches with anthropic SDK streaming path", () => {
      const stack =
        "SyntaxError: Unexpected end of JSON input\n" +
        "    at JSON.parse (<anonymous>)\n" +
        "    at processChunk (node_modules/@anthropic-ai/sdk/core/streaming.mjs:120:30)";
      expect(isLikelySSEParseError(sseMessage, stack)).toBe(true);
    });

    it("matches with openai SDK streaming path", () => {
      const stack =
        "SyntaxError: Unexpected end of JSON input\n" +
        "    at JSON.parse (<anonymous>)\n" +
        "    at Stream.parse (node_modules/openai/streaming.js:88:15)";
      expect(isLikelySSEParseError(sseMessage, stack)).toBe(true);
    });

    it("rejects with tool parser stack", () => {
      expect(isLikelySSEParseError(sseMessage, NON_STREAMING_STACK)).toBe(false);
    });

    it("rejects with config loader stack", () => {
      const stack =
        "SyntaxError: Unexpected end of JSON input\n" +
        "    at JSON.parse (<anonymous>)\n" +
        "    at loadConfig (src/config/loader.js:15:25)";
      expect(isLikelySSEParseError(sseMessage, stack)).toBe(false);
    });
  });
});
