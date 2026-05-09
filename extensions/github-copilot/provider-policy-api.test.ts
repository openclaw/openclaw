import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("github-copilot provider-policy-api", () => {
  it("returns the base level set for non-xhigh github-copilot models", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "claude-opus-4.6",
      })?.levels.map((level) => level.id),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("appends xhigh for the long-context Opus 4.7 1m variant", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "claude-opus-4.7-1m-internal",
      })?.levels.map((level) => level.id),
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });

  it("appends xhigh for GPT-5.4 / 5.3-codex / 5.2 variants", () => {
    for (const modelId of ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.2-codex"]) {
      expect(
        resolveThinkingProfile({
          provider: "github-copilot",
          modelId,
        })?.levels.map((level) => level.id),
        `model=${modelId}`,
      ).toContain("xhigh");
    }
  });

  it("normalizes the model id casing before xhigh membership check", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "CLAUDE-OPUS-4.7-1M-INTERNAL",
      })?.levels.map((level) => level.id),
    ).toContain("xhigh");
  });

  it("returns null for non-github-copilot providers", () => {
    expect(
      resolveThinkingProfile({
        provider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBeNull();
    expect(
      resolveThinkingProfile({
        provider: "anthropic",
        modelId: "claude-opus-4.6",
      }),
    ).toBeNull();
  });
});
