import { describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/provider-runtime.js", () => ({
  classifyProviderFailoverReasonWithPlugin: () => null,
  matchesProviderContextOverflowWithPlugin: () => false,
}));

import { formatAssistantErrorText } from "./errors.js";

function msg(errorMessage: string) {
  return { stopReason: "error" as const, errorMessage } as Parameters<
    typeof formatAssistantErrorText
  >[0];
}

describe("formatAssistantErrorText – JSON stream truncation errors", () => {
  it("handles V8 'Expected … in JSON at position N' (the real-world case)", () => {
    const result = formatAssistantErrorText(
      msg("Expected ',' or ']' after array element in JSON at position 900 (line 1 column 901)"),
    );
    expect(result).toBe("LLM request failed: response was truncated mid-stream. Please try again.");
  });

  it("handles V8 'Expected … in JSON at position N' at other positions", () => {
    const result = formatAssistantErrorText(
      msg("Expected ',' or '}' after property value in JSON at position 42"),
    );
    expect(result).toBe("LLM request failed: response was truncated mid-stream. Please try again.");
  });

  it("handles V8 'Unexpected end of JSON input'", () => {
    const result = formatAssistantErrorText(msg("Unexpected end of JSON input"));
    expect(result).toBe("LLM request failed: response was truncated mid-stream. Please try again.");
  });

  it("handles JSC 'JSON Parse error: Unexpected EOF'", () => {
    const result = formatAssistantErrorText(msg("JSON Parse error: Unexpected EOF"));
    expect(result).toBe("LLM request failed: response was truncated mid-stream. Please try again.");
  });

  it("does NOT match 'Unexpected token' (ambiguous – could be corrupted data, not truncation)", () => {
    const result = formatAssistantErrorText(msg("Unexpected token u in JSON at position 0"));
    // Falls through to raw error – correct behaviour so callers get accurate diagnostics
    expect(result).not.toBe(
      "LLM request failed: response was truncated mid-stream. Please try again.",
    );
  });

  it("does NOT match unrelated error messages", () => {
    const result = formatAssistantErrorText(msg("LLM request timed out."));
    expect(result).not.toBe(
      "LLM request failed: response was truncated mid-stream. Please try again.",
    );
  });
});
