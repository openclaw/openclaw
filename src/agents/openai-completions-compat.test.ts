import { describe, expect, it } from "vitest";
import { resolveOpenAICompletionsCompatDefaults } from "./openai-completions-compat.js";

describe("resolveOpenAICompletionsCompatDefaults", () => {
  it("enables streaming usage for local ollama OpenAI-compat endpoints", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "ollama",
        endpointClass: "local",
        knownProviderFamily: "ollama",
      }).supportsUsageInStreaming,
    ).toBe(true);
  });

  it("keeps streaming usage enabled for custom ollama OpenAI-compat endpoints", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "ollama",
        endpointClass: "custom",
        knownProviderFamily: "ollama",
      }).supportsUsageInStreaming,
    ).toBe(true);
  });

  it("defaults streaming usage on for generic custom providers (most OpenAI-compat APIs support it)", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "custom-cpa",
        endpointClass: "custom",
        knownProviderFamily: "custom-cpa",
      }).supportsUsageInStreaming,
    ).toBe(true);
  });
});
