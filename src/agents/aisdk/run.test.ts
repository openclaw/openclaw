import { describe, expect, it } from "vitest";
import { mapThinkLevelToAnthropicOptions } from "./run.js";

describe("AI SDK Run", () => {
  describe("mapThinkLevelToAnthropicOptions", () => {
    it("returns empty object for non-anthropic provider", () => {
      expect(mapThinkLevelToAnthropicOptions("high", "openai")).toEqual({});
      expect(mapThinkLevelToAnthropicOptions("high", "google")).toEqual({});
    });

    it("returns empty object for off thinking level", () => {
      expect(mapThinkLevelToAnthropicOptions("off", "anthropic")).toEqual({});
      expect(mapThinkLevelToAnthropicOptions(undefined, "anthropic")).toEqual({});
    });

    it("maps minimal to 2000 budget tokens", () => {
      const result = mapThinkLevelToAnthropicOptions("minimal", "anthropic");
      expect(result.thinking).toEqual({ type: "enabled", budgetTokens: 2000 });
      expect(result.effort).toBe("low");
    });

    it("maps low to 4000 budget tokens", () => {
      const result = mapThinkLevelToAnthropicOptions("low", "anthropic");
      expect(result.thinking).toEqual({ type: "enabled", budgetTokens: 4000 });
      expect(result.effort).toBe("low");
    });

    it("maps medium to 8000 budget tokens", () => {
      const result = mapThinkLevelToAnthropicOptions("medium", "anthropic");
      expect(result.thinking).toEqual({ type: "enabled", budgetTokens: 8000 });
      expect(result.effort).toBe("medium");
    });

    it("maps high to 16000 budget tokens with high effort", () => {
      const result = mapThinkLevelToAnthropicOptions("high", "anthropic");
      expect(result.thinking).toEqual({ type: "enabled", budgetTokens: 16000 });
      expect(result.effort).toBe("high");
    });

    it("maps xhigh to 32000 budget tokens with high effort", () => {
      const result = mapThinkLevelToAnthropicOptions("xhigh", "anthropic");
      expect(result.thinking).toEqual({ type: "enabled", budgetTokens: 32000 });
      expect(result.effort).toBe("high");
    });
  });
});
