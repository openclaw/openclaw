import { describe, expect, it } from "vitest";
import { isLikelySSEParseError } from "../pi-embedded-helpers.js";

describe("isLikelySSEParseError", () => {
  it("returns false for undefined/empty input", () => {
    expect(isLikelySSEParseError(undefined)).toBe(false);
    expect(isLikelySSEParseError("")).toBe(false);
  });

  it("detects SyntaxError + JSON context", () => {
    expect(isLikelySSEParseError("SyntaxError: Unexpected end of JSON input")).toBe(true);
    expect(isLikelySSEParseError("SyntaxError: Unexpected token < in JSON at position 0")).toBe(
      true,
    );
    expect(isLikelySSEParseError("Syntax error while parsing SSE stream JSON data")).toBe(true);
  });

  it("detects unexpected end of JSON without SyntaxError prefix", () => {
    expect(isLikelySSEParseError("Unexpected end of JSON input")).toBe(true);
  });

  it("detects unexpected token + JSON context", () => {
    expect(isLikelySSEParseError("Unexpected token } in JSON at position 42")).toBe(true);
  });

  it("detects unterminated string in JSON", () => {
    expect(isLikelySSEParseError("Unterminated string in JSON at position 100")).toBe(true);
  });

  it("detects bad control character in string literal + JSON", () => {
    expect(
      isLikelySSEParseError("Bad control character in string literal in JSON at position 5"),
    ).toBe(true);
  });

  it("detects Anthropic SDK SSE-specific patterns", () => {
    expect(isLikelySSEParseError("Could not parse SSE event")).toBe(true);
    expect(isLikelySSEParseError("Failed to parse SSE data")).toBe(true);
    expect(isLikelySSEParseError("malformed SSE event from proxy")).toBe(true);
  });

  it("detects JSON parse errors from SSE stream context", () => {
    expect(isLikelySSEParseError("SyntaxError: Unexpected end of JSON input from SSE stream")).toBe(
      true,
    );
    expect(
      isLikelySSEParseError("SyntaxError: Unexpected token < in JSON at position 0 (stream)"),
    ).toBe(true);
  });

  it("detects expected property name errors", () => {
    expect(
      isLikelySSEParseError("Expected double-quoted property name in JSON at position 12"),
    ).toBe(true);
  });

  it("detects expected comma or brace errors", () => {
    expect(
      isLikelySSEParseError("Expected ',' or '}' after property value in JSON at position 50"),
    ).toBe(true);
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

  it("matches real-world Azure proxy truncation error", () => {
    // Simulates what the Anthropic SDK throws when Azure truncates SSE data lines
    expect(
      isLikelySSEParseError(
        "SyntaxError: Expected double-quoted property name in JSON at position 83 (line 1 column 84)",
      ),
    ).toBe(true);
  });

  it("matches real-world newline-in-thinking error", () => {
    // Simulates what happens when thinking_delta contains raw newlines breaking SSE framing
    expect(isLikelySSEParseError("SyntaxError: Unexpected end of JSON input")).toBe(true);
  });
});
