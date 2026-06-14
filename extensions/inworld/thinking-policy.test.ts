import { describe, expect, it } from "vitest";
import { parseInworldModel } from "./models.js";
import { resolveInworldThinkingProfile } from "./thinking-policy.js";

describe("resolveInworldThinkingProfile", () => {
  it("returns undefined for a model not in the catalog", () => {
    expect(resolveInworldThinkingProfile("unknown/no-such-model")).toBeUndefined();
  });

  it("maps EFFORT_* levels to openclaw effort ids and prefers medium as default", () => {
    parseInworldModel({
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      isSupported: true,
      spec: {
        capabilities: {
          reasoning: true,
          reasoningCapability: {
            supportedLevels: [
              "EFFORT_NONE",
              "EFFORT_MINIMAL",
              "EFFORT_LOW",
              "EFFORT_MEDIUM",
              "EFFORT_HIGH",
              "EFFORT_XHIGH",
            ],
          },
        },
      },
    });

    const profile = resolveInworldThinkingProfile("anthropic/claude-haiku-4-5-20251001");
    expect(profile?.levels.map((l) => l.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(profile?.defaultLevel).toBe("medium");
  });

  it("accepts the lowercase short form supportedLevels (forward-compat)", () => {
    parseInworldModel({
      model: "gemini-2.5-flash",
      provider: "google-ai-studio",
      isSupported: true,
      spec: {
        capabilities: {
          reasoning: true,
          reasoningCapability: { supportedLevels: ["none", "low", "medium", "high", "xhigh"] },
        },
      },
    });
    const profile = resolveInworldThinkingProfile("google-ai-studio/gemini-2.5-flash");
    expect(profile?.levels.map((l) => l.id)).toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(profile?.defaultLevel).toBe("medium");
  });

  it("falls back to the highest level when medium is unavailable (e.g. gpt-5.4)", () => {
    parseInworldModel({
      model: "gpt-5.4",
      provider: "openai",
      isSupported: true,
      spec: {
        capabilities: {
          reasoning: true,
          reasoningCapability: {
            supportedLevels: ["EFFORT_NONE", "EFFORT_LOW", "EFFORT_HIGH", "EFFORT_XHIGH"],
          },
        },
      },
    });

    const profile = resolveInworldThinkingProfile("openai/gpt-5.4");
    expect(profile?.levels.map((l) => l.id)).toEqual(["off", "low", "high", "xhigh"]);
    expect(profile?.defaultLevel).toBe("xhigh");
  });
});
