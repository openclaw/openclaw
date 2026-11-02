import { describe, expect, it } from "vitest";
import { resolveThinkingProfile, resolveZaiReasoningEffort } from "./provider-policy-api.js";

describe("zai provider thinking policy", () => {
  it("exposes GLM 5.3 effort levels for preview models", () => {
    expect(resolveThinkingProfile({ provider: "zai", modelId: "glm-5.3-preview" })).toEqual({
      levels: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "max",
    });
  });

  it("exposes full GLM 5.2 levels for Flash", () => {
    expect(resolveThinkingProfile({ provider: "zai", modelId: "glm-5.2-flash" })).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "off",
    });
  });

  it.each([
    ["glm-5.3", "minimal", "low"],
    ["glm-5.3", "medium", "high"],
    ["glm-5.3", "adaptive", "max"],
    ["glm-5.3", "xhigh", "max"],
    ["glm-5.2", "low", "high"],
    ["glm-5.2", "max", "max"],
  ] as const)("maps %s %s to reasoning effort %s", (modelId, level, expected) => {
    expect(resolveZaiReasoningEffort(modelId, level)).toBe(expected);
  });
});
