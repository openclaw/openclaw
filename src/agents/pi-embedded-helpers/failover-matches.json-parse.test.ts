import { describe, expect, it } from "vitest";
import { isJsonParseError, isOverloadedErrorMessage } from "./failover-matches.js";

describe("isJsonParseError", () => {
  it("matches 'Bad escaped character in JSON'", () => {
    expect(isJsonParseError("Bad escaped character in JSON at position 70")).toBe(true);
  });

  it("matches 'Bad control character in string literal in JSON'", () => {
    expect(
      isJsonParseError("Bad control character in string literal in JSON at position 154"),
    ).toBe(true);
  });

  it("matches SyntaxError JSON messages", () => {
    expect(isJsonParseError("SyntaxError: Unexpected token in JSON at position 42")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isJsonParseError("The AI service is temporarily overloaded")).toBe(false);
    expect(isJsonParseError("rate limit exceeded")).toBe(false);
    expect(isJsonParseError("")).toBe(false);
  });
});

describe("isOverloadedErrorMessage excludes JSON parse errors", () => {
  it("still matches genuine overloaded errors", () => {
    expect(isOverloadedErrorMessage("overloaded_error")).toBe(true);
    expect(isOverloadedErrorMessage("The AI service is temporarily overloaded")).toBe(true);
    expect(isOverloadedErrorMessage("service unavailable")).toBe(true);
  });

  it("does NOT match JSON parse errors even if they contain 'overloaded' context", () => {
    // Simulate a wrapped error that contains both JSON parse info and overloaded text
    const wrappedError = "Bad escaped character in JSON at position 70 (overloaded_error context)";
    expect(isOverloadedErrorMessage(wrappedError)).toBe(false);
  });

  it("does NOT match plain JSON parse errors", () => {
    expect(isOverloadedErrorMessage("Bad escaped character in JSON at position 129")).toBe(false);
    expect(
      isOverloadedErrorMessage("Bad control character in string literal in JSON at position 155"),
    ).toBe(false);
  });
});
