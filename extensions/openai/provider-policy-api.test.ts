import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("OpenAI provider policy artifact", () => {
  it("keeps legacy Codex thinking policy for openai-codex refs", () => {
    const codexProfile = resolveThinkingProfile({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
    });
    const openaiProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
    });

    expect(codexProfile?.levels.map((level) => level.id)).toContain("xhigh");
    expect(openaiProfile?.levels.map((level) => level.id)).not.toContain("xhigh");
  });
});
