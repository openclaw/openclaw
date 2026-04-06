import { describe, expect, it } from "vitest";
import { createLiveTargetMatcher } from "./live-target-matcher.js";

describe("createLiveTargetMatcher", () => {
  it("matches Anthropic-owned models for the claude-cli provider filter", () => {
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["claude-cli"]),
      modelFilter: null,
    });

    expect(matcher.matchesProvider("anthropic")).toBe(true);
    expect(matcher.matchesProvider("openai")).toBe(false);
  });

  it("matches Anthropic model refs for claude-cli explicit model filters", () => {
    const matcher = createLiveTargetMatcher({
      providerFilter: null,
      modelFilter: new Set(["claude-cli/claude-sonnet-4-6"]),
    });

    expect(matcher.matchesModel("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(matcher.matchesModel("anthropic", "claude-opus-4-6")).toBe(false);
  });

  it("keeps direct provider/model matches working", () => {
    const matcher = createLiveTargetMatcher({
      providerFilter: new Set(["openrouter"]),
      modelFilter: new Set(["openrouter/openai/gpt-5.4"]),
    });

    expect(matcher.matchesProvider("openrouter")).toBe(true);
    expect(matcher.matchesModel("openrouter", "openai/gpt-5.4")).toBe(true);
  });
});
