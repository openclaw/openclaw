// Openai tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("OpenAI provider policy artifact", () => {
  it("keeps OpenAI thinking policy for openai refs", () => {
    const codexProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
    });
    const openaiProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3",
    });
    const openaiMiniProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });

    expect(codexProfile?.levels.map((level) => level.id)).toContain("xhigh");
    expect(openaiProfile?.levels.map((level) => level.id)).not.toContain("xhigh");
    expect(openaiMiniProfile?.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("exposes max for the GPT-5.6 series", () => {
    const solLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
    })?.levels.map((level) => level.id);
    const terraLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-terra",
    })?.levels.map((level) => level.id);
    const lunaLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-luna",
    })?.levels.map((level) => level.id);

    expect(solLevels).toContain("max");
    expect(terraLevels).toContain("xhigh");
    expect(terraLevels).toContain("max");
    expect(lunaLevels).toContain("xhigh");
    expect(lunaLevels).toContain("max");
  });

  it("preserves GPT-5 nano thinking when catalog reasoning metadata is stale", () => {
    const profile = resolveThinkingProfile({
      provider: "openai",
      modelId: "openai/gpt-5-nano",
    });

    expect(profile?.levels.map((level) => level.id)).toContain("minimal");
    expect(profile?.preserveWhenCatalogReasoningFalse).toBe(true);
  });

  it("keeps catalog reasoning=false authoritative for OpenAI chat-latest rows", () => {
    const profile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3-chat-latest",
    });

    expect(profile?.preserveWhenCatalogReasoningFalse).toBeUndefined();
  });
});
