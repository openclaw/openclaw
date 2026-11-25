import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";

describe("xai provider thinking policy", () => {
  it.each([
    ["xai", "grok-4.3"],
    ["x-ai", "grok-4.3-latest"],
    ["x-ai", "grok-latest"],
  ])("exposes Grok 4.3 thinking levels for %s/%s", (provider, modelId) => {
    // Catalog rows reach the policy after runtime normalization stamps their ID-rule efforts.
    const stamped = applyXaiRuntimeModelCompat({ id: modelId, reasoning: true }).compat
      .supportedReasoningEfforts;
    if (!Array.isArray(stamped)) {
      throw new Error("expected runtime normalization to stamp Grok 4.3 efforts");
    }
    for (const profile of [
      resolveThinkingProfile({ provider, modelId }),
      resolveThinkingProfile({ provider, modelId, compat: { supportedReasoningEfforts: stamped } }),
    ]) {
      expect(profile.defaultLevel).toBe("low");
      expect(profile.levels.map((level) => level.id)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
      ]);
    }
  });

  it.each([["x-ai", "grok-build-latest"]])(
    "uses xAI's high reasoning default for %s/%s",
    (provider, modelId) => {
      const profile = resolveThinkingProfile({
        provider,
        modelId,
      });

      expect(profile).toEqual({
        levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
        defaultLevel: "high",
      });
    },
  );

  it.each([["xai", "grok-4.8"]])("exposes xhigh reasoning for %s/%s", (provider, modelId) => {
    expect(resolveThinkingProfile({ provider, modelId })).toEqual({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
      defaultLevel: "high",
    });
  });

  it("keeps non-reasoning and non-xai routes off-only", () => {
    expect(
      resolveThinkingProfile({
        provider: "xai",
        modelId: "grok-4-fast-non-reasoning",
        reasoning: false,
      }),
    ).toEqual({ levels: [{ id: "off" }], defaultLevel: "off" });
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "x-ai/grok-4.3",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "off" }], defaultLevel: "off" });
  });

  it.each([
    ["xai", "grok-4.20"],
    ["xai", "grok-4-0709"],
    ["xai", "grok-4.8-fast"],
  ])("does not advertise configurable reasoning for %s/%s", (provider, modelId) => {
    expect(resolveThinkingProfile({ provider, modelId })).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });
});
