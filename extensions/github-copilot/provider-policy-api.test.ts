// Github Copilot tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("github-copilot provider-policy-api", () => {
  it.each([{ supportsReasoningEffort: false, supportedReasoningEfforts: ["xhigh", "max"] }])(
    "honors explicit catalog limits before static GPT metadata: %j",
    (compat) => {
      expect(
        resolveThinkingProfile({
          provider: "github-copilot",
          modelId: "gpt-5.6-luna",
          compat,
        })?.levels.map(({ id }) => id),
      ).toEqual(["off", "minimal", "low", "medium", "high"]);
    },
  );

  it("returns null for non-GitHub Copilot providers", () => {
    expect(
      resolveThinkingProfile({
        provider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBeNull();
  });
});
