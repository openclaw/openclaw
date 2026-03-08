import { describe, expect, it } from "vitest";
import { resolveProviderCapabilities } from "./provider-capabilities.js";

describe("resolveProviderCapabilities", () => {
  it("returns native anthropic defaults for ordinary providers", () => {
    expect(resolveProviderCapabilities("anthropic")).toEqual({
      anthropicToolSchemaMode: "native",
      anthropicToolChoiceMode: "native",
      preserveAnthropicThinkingSignatures: true,
    });
  });

  it("normalizes kimi aliases to the same capability set", () => {
    expect(resolveProviderCapabilities("kimi-coding")).toEqual(
      resolveProviderCapabilities("kimi-code"),
    );
    expect(resolveProviderCapabilities("kimi-code")).toEqual({
      anthropicToolSchemaMode: "openai-functions",
      anthropicToolChoiceMode: "openai-string-modes",
      preserveAnthropicThinkingSignatures: false,
    });
  });
});
