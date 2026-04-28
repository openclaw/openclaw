import { describe, expect, it } from "vitest";
import { resolveThinkingProfileFromCapabilities } from "./thinking.js";

describe("resolveThinkingProfileFromCapabilities", () => {
  it("returns default levels when no capabilities provided", () => {
    const profile = resolveThinkingProfileFromCapabilities(undefined);
    const ids = profile.levels.map((l) => l.id);
    expect(ids).toContain("off");
    expect(ids).toContain("medium");
    expect(ids).toContain("high");
  });

  it("maps reasoning_effort levels to thinking levels", () => {
    const profile = resolveThinkingProfileFromCapabilities({
      reasoningEffort: ["low", "medium", "high", "xhigh"],
    });
    const ids = profile.levels.map((l) => l.id);
    expect(ids).toContain("off");
    expect(ids).toContain("minimal");
    expect(ids).toContain("low");
    expect(ids).toContain("medium");
    expect(ids).toContain("high");
    expect(ids).toContain("xhigh");
  });

  it("adds adaptive level for models with adaptive_thinking", () => {
    const profile = resolveThinkingProfileFromCapabilities({
      adaptiveThinking: true,
      reasoningEffort: ["low", "medium", "high"],
    });
    const ids = profile.levels.map((l) => l.id);
    expect(ids).toContain("adaptive");
  });

  it("does not add adaptive for non-adaptive models", () => {
    const profile = resolveThinkingProfileFromCapabilities({
      adaptiveThinking: false,
      reasoningEffort: ["low", "medium", "high"],
    });
    const ids = profile.levels.map((l) => l.id);
    expect(ids).not.toContain("adaptive");
  });

  it("maps 'none' reasoning effort to 'off'", () => {
    const profile = resolveThinkingProfileFromCapabilities({
      reasoningEffort: ["none", "low", "medium", "high"],
    });
    const ids = profile.levels.map((l) => l.id);
    // "none" maps to "off" which is already in the base levels
    expect(ids.filter((id) => id === "off")).toHaveLength(1);
  });

  it("sorts levels by rank", () => {
    const profile = resolveThinkingProfileFromCapabilities({
      adaptiveThinking: true,
      reasoningEffort: ["high", "low", "medium", "xhigh"],
    });
    const ranks = profile.levels.map((l) => l.rank ?? 0);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    }
  });

  it("handles models with only thinking budget and no reasoning_effort", () => {
    const profile = resolveThinkingProfileFromCapabilities({
      maxThinkingBudget: 32000,
      minThinkingBudget: 256,
    });
    // Should return default levels since no reasoning_effort
    const ids = profile.levels.map((l) => l.id);
    expect(ids).toContain("off");
    expect(ids).toContain("medium");
  });

  it("handles Claude-style capabilities", () => {
    const profile = resolveThinkingProfileFromCapabilities({
      adaptiveThinking: true,
      maxThinkingBudget: 32000,
      minThinkingBudget: 1024,
      reasoningEffort: ["low", "medium", "high"],
      toolCalls: true,
      streaming: true,
    });
    const ids = profile.levels.map((l) => l.id);
    expect(ids).toEqual(["off", "minimal", "low", "medium", "high", "adaptive"]);
  });

  it("handles GPT-5.4 style capabilities with xhigh", () => {
    const profile = resolveThinkingProfileFromCapabilities({
      reasoningEffort: ["low", "medium", "high", "xhigh"],
      toolCalls: true,
      streaming: true,
    });
    const ids = profile.levels.map((l) => l.id);
    expect(ids).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
  });
});
