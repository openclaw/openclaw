// Github Copilot tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("github-copilot provider-policy-api", () => {
  it("returns the base level set for non-xhigh GitHub Copilot models", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "claude-haiku-4.5",
      })?.levels.map((level) => level.id),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("appends max when catalog compat advertises it", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "claude-fable-5",
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
      })?.levels.map((level) => level.id),
    ).toContain("max");
  });

  it.each([undefined, null])("does not expose older Claude adaptive effort with api=%s", (api) => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "claude-opus-4-5",
        api,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
      })?.levels.map((level) => level.id),
    ).not.toContain("max");
  });

  it.each([
    { supportedReasoningEfforts: ["low", "medium", "high"] },
    { supportedReasoningEfforts: [] },
    { supportsReasoningEffort: false, supportedReasoningEfforts: ["xhigh", "max"] },
  ])("honors explicit catalog limits before static GPT metadata: %j", (compat) => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "gpt-5.6-luna",
        compat,
      })?.levels.map(({ id }) => id),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it.each(["openai-completions", undefined, null])(
    "does not expose Gemini max with api=%s",
    (api) => {
      expect(
        resolveThinkingProfile({
          provider: "github-copilot",
          modelId: "gemini-3.6-flash",
          api,
          compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
        })?.levels.map(({ id }) => id),
      ).not.toContain("max");
    },
  );

  it("appends xhigh for static Copilot metadata overrides", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "claude-opus-4.7-1m-internal",
      })?.levels.map((level) => level.id),
    ).toContain("xhigh");
  });

  it("normalizes the model id casing before xhigh membership checks", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "GPT-5.4",
      })?.levels.map((level) => level.id),
    ).toContain("xhigh");
  });

  it("returns null for non-GitHub Copilot providers", () => {
    expect(
      resolveThinkingProfile({
        provider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBeNull();
  });
});
