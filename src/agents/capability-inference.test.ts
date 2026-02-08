import { describe, expect, it } from "vitest";
import { inferModelCapabilities } from "./capability-inference.js";

describe("inferModelCapabilities", () => {
  describe("performance tier inference", () => {
    it("should classify opus models as powerful", () => {
      const caps = inferModelCapabilities("claude-opus-4-6");
      expect(caps.performanceTier).toBe("powerful");
    });

    it("should classify haiku models as fast", () => {
      const caps = inferModelCapabilities("claude-haiku-4-5");
      expect(caps.performanceTier).toBe("fast");
      expect(caps.fast).toBe(true);
    });

    it("should classify sonnet models as balanced", () => {
      const caps = inferModelCapabilities("claude-sonnet-4-5");
      expect(caps.performanceTier).toBe("balanced");
    });

    it("should classify mini models as fast", () => {
      const caps = inferModelCapabilities("gpt-4o-mini");
      expect(caps.performanceTier).toBe("fast");
      expect(caps.fast).toBe(true);
    });

    it("should classify gpt-5.2 as powerful", () => {
      const caps = inferModelCapabilities("gpt-5.2");
      expect(caps.performanceTier).toBe("powerful");
    });

    it("should classify flash models as fast", () => {
      const caps = inferModelCapabilities("gemini-3-flash");
      expect(caps.performanceTier).toBe("fast");
    });

    it("should classify unknown models as balanced", () => {
      const caps = inferModelCapabilities("some-unknown-model");
      expect(caps.performanceTier).toBe("balanced");
    });
  });

  describe("coding inference", () => {
    it("should detect coding from codex pattern", () => {
      const caps = inferModelCapabilities("gpt-5.2-codex");
      expect(caps.coding).toBe(true);
    });

    it("should detect coding from coder pattern", () => {
      const caps = inferModelCapabilities("qwen2.5-coder-32b");
      expect(caps.coding).toBe(true);
    });

    it("should infer coding for powerful models", () => {
      const caps = inferModelCapabilities("claude-opus-4-6");
      expect(caps.coding).toBe(true);
    });

    it("should infer coding for known balanced families", () => {
      const caps = inferModelCapabilities("claude-sonnet-5-0");
      expect(caps.coding).toBe(true);
    });

    it("should not infer coding for unknown fast models", () => {
      const caps = inferModelCapabilities("some-tiny-model");
      expect(caps.coding).toBe(false);
    });
  });

  describe("reasoning inference", () => {
    it("should detect reasoning from catalog metadata", () => {
      const caps = inferModelCapabilities("some-model", {
        provider: "anthropic",
        reasoning: true,
        input: ["text"],
      });
      expect(caps.reasoning).toBe(true);
    });

    it("should detect reasoning from deepseek-r1 pattern", () => {
      const caps = inferModelCapabilities("deepseek-r1");
      expect(caps.reasoning).toBe(true);
    });

    it("should detect reasoning from o3 pattern", () => {
      const caps = inferModelCapabilities("o3-mini");
      expect(caps.reasoning).toBe(true);
    });

    it("should not infer reasoning without evidence", () => {
      const caps = inferModelCapabilities("gpt-4o");
      expect(caps.reasoning).toBe(false);
    });
  });

  describe("vision inference", () => {
    it("should detect vision from catalog metadata", () => {
      const caps = inferModelCapabilities("some-model", {
        provider: "openai",
        input: ["text", "image"],
      });
      expect(caps.vision).toBe(true);
    });

    it("should detect vision from gpt-4o pattern", () => {
      const caps = inferModelCapabilities("gpt-4o");
      expect(caps.vision).toBe(true);
    });

    it("should prefer catalog metadata over pattern", () => {
      const caps = inferModelCapabilities("gpt-4o", {
        provider: "openai",
        input: ["text"],
      });
      // Catalog says text-only, so vision should be false
      expect(caps.vision).toBe(false);
    });
  });

  describe("cost tier inference", () => {
    it("should classify ollama models as free", () => {
      const caps = inferModelCapabilities("llama3:8b", {
        provider: "ollama",
        input: ["text"],
      });
      expect(caps.costTier).toBe("free");
    });

    it("should classify groq models as cheap", () => {
      const caps = inferModelCapabilities("llama3-70b", {
        provider: "groq",
        input: ["text"],
      });
      expect(caps.costTier).toBe("cheap");
    });

    it("should classify powerful models as expensive", () => {
      const caps = inferModelCapabilities("claude-opus-4-6");
      expect(caps.costTier).toBe("expensive");
    });

    it("should classify fast models as cheap", () => {
      const caps = inferModelCapabilities("claude-haiku-4-5");
      expect(caps.costTier).toBe("cheap");
    });

    it("should default to moderate for unknown models", () => {
      const caps = inferModelCapabilities("some-unknown-model");
      expect(caps.costTier).toBe("moderate");
    });
  });

  describe("creative inference", () => {
    it("should infer creative for opus models", () => {
      const caps = inferModelCapabilities("claude-opus-4-6");
      expect(caps.creative).toBe(true);
    });

    it("should infer creative for powerful models", () => {
      const caps = inferModelCapabilities("gpt-5.2");
      expect(caps.creative).toBe(true);
    });

    it("should not infer creative for fast models", () => {
      const caps = inferModelCapabilities("claude-haiku-4-5");
      expect(caps.creative).toBe(false);
    });
  });

  describe("general capability", () => {
    it("should always be true", () => {
      expect(inferModelCapabilities("any-model").general).toBe(true);
      expect(inferModelCapabilities("claude-opus-4-6").general).toBe(true);
      expect(inferModelCapabilities("tiny-model").general).toBe(true);
    });
  });

  describe("known model validation", () => {
    it("should produce reasonable output for claude-opus-4-6", () => {
      const caps = inferModelCapabilities("claude-opus-4-6");
      expect(caps).toEqual({
        coding: true,
        reasoning: false,
        vision: false,
        general: true,
        fast: false,
        creative: true,
        performanceTier: "powerful",
        costTier: "expensive",
      });
    });

    it("should produce reasonable output for claude-opus-4-6 with catalog", () => {
      const caps = inferModelCapabilities("claude-opus-4-6", {
        provider: "anthropic",
        reasoning: true,
        input: ["text", "image"],
      });
      expect(caps).toEqual({
        coding: true,
        reasoning: true,
        vision: true,
        general: true,
        fast: false,
        creative: true,
        performanceTier: "powerful",
        costTier: "expensive",
      });
    });

    it("should handle gpt-5.1-codex-mini correctly", () => {
      const caps = inferModelCapabilities("gpt-5.1-codex-mini");
      expect(caps.coding).toBe(true);
      expect(caps.fast).toBe(true);
      expect(caps.performanceTier).toBe("fast");
    });

    it("should handle deepseek-r1 correctly", () => {
      const caps = inferModelCapabilities("deepseek-r1");
      expect(caps.reasoning).toBe(true);
      expect(caps.coding).toBe(true);
      expect(caps.performanceTier).toBe("powerful");
    });
  });
});
