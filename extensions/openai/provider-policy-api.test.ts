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

  it("applies OpenAI thinking policy to custom openai-responses refs", () => {
    const profile = resolveThinkingProfile({
      provider: "custom-openai",
      api: "openai-responses",
      modelId: "gpt-5.5",
    });
    const unrelatedProfile = resolveThinkingProfile({
      provider: "custom-openai",
      api: "anthropic-messages",
      modelId: "gpt-5.5",
    });

    expect(profile?.levels.map((level) => level.id)).toContain("xhigh");
    expect(unrelatedProfile).toBeNull();
  });
});
