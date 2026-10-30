import { expect, it } from "vitest";
import { buildOpenAIProvider } from "../openai-provider.js";

export function registerOpenAIFailoverTests() {
  it("classifies OpenAI-native code-only failover errors", () => {
    const provider = buildOpenAIProvider();

    for (const providerId of ["openai", "azure-openai", "azure-openai-responses"]) {
      for (const [code, reason] of [
        ["CONTEXT_LENGTH_EXCEEDED", "context_overflow"],
        ["INVALID_PROMPT", "format"],
        ["INVALID_REQUEST_ERROR", "format"],
        ["CONTENT_POLICY_VIOLATION", "format"],
        ["CONTENT_FILTER", "format"],
        ["USAGE_LIMIT_REACHED", "rate_limit"],
        ["USAGE_NOT_INCLUDED", "billing"],
      ]) {
        expect(
          provider.classifyFailoverReason?.({
            provider: providerId,
            errorMessage: "",
            code,
          }),
        ).toBe(reason);
      }
      for (const errorMessage of [
        "Provider finish_reason: content_filter",
        "Provider incomplete_reason: content_filter",
      ]) {
        expect(provider.classifyFailoverReason?.({ provider: providerId, errorMessage })).toBe(
          "format",
        );
      }
      expect(
        provider.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "",
          code: "SERVER_ERROR",
        }),
      ).toBe("server_error");
      expect(
        provider.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "",
          code: "INSUFFICIENT_QUOTA",
        }),
      ).toBe("billing");
    }
    // API_ERROR is an Anthropic-native code, not OpenAI's: fall through to generic.
    expect(
      provider.classifyFailoverReason?.({
        provider: "openai",
        errorMessage: "",
        code: "API_ERROR",
      }),
    ).toBeUndefined();
  });
}
