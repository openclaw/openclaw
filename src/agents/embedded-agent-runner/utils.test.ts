// Embedded runner utility tests cover small mapping helpers shared by run setup
// and provider option normalization.
import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "./utils.js";

describe("mapThinkingLevel", () => {
  it("maps adaptive to the provider-owned high effort default", () => {
    expect(mapThinkingLevel("adaptive")).toBe("high");
  });

  it("maps logical Ultra to provider max effort", () => {
    const level = mapThinkingLevelForProvider("ultra", {
      provider: "custom",
      id: "max-model",
      reasoning: true,
      thinkingLevelMap: { max: "max" },
    });
    expect(level).toBe("max");
    expect(mapThinkingLevel(level)).toBe("max");
  });

  it("accepts transport-only compat without losing Anthropic effort support", () => {
    const model: Model<"anthropic-messages"> = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Sonnet",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsEagerToolInputStreaming: false },
    };
    expect(mapThinkingLevelForProvider("ultra", model)).toBe("high");
  });

  it("preserves provider-native adaptive outside agent-core", () => {
    expect(
      mapThinkingLevelForProvider("adaptive", { provider: "custom", id: "adaptive-model" }),
    ).toBe("adaptive");
  });
});
