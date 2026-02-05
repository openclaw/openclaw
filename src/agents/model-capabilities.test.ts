import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "./model-catalog.js";
import {
  MODEL_CAPABILITIES_REGISTRY,
  enrichCatalogWithCapabilities,
  filterByCapability,
  getCapabilityTags,
  getCodingModels,
  getFastModels,
  getModelCapabilities,
  getModelCapabilitiesFromCatalog,
  getModelsByCostTier,
  getModelsByTier,
  getReasoningModels,
  getVisionModels,
} from "./model-capabilities.js";

describe("model-capabilities", () => {
  describe("getModelCapabilities", () => {
    it("returns capabilities for known models", () => {
      const caps = getModelCapabilities("claude-opus-4-5");
      expect(caps.coding).toBe(true);
      expect(caps.reasoning).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.performanceTier).toBe("powerful");
      expect(caps.costTier).toBe("expensive");
    });

    it("returns capabilities for gpt-4o", () => {
      const caps = getModelCapabilities("gpt-4o");
      expect(caps.coding).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.performanceTier).toBe("balanced");
    });

    it("returns default capabilities for unknown models", () => {
      const caps = getModelCapabilities("unknown-model-xyz");
      expect(caps.coding).toBe(false);
      expect(caps.reasoning).toBe(false);
      expect(caps.general).toBe(true);
      expect(caps.performanceTier).toBe("balanced");
      expect(caps.costTier).toBe("moderate");
    });

    it("handles case-insensitive matching", () => {
      const caps = getModelCapabilities("CLAUDE-OPUS-4-5");
      expect(caps.coding).toBe(true);
    });

    it("handles prefix matching for versioned models", () => {
      const caps = getModelCapabilities("gpt-4o-2024-11-20-some-suffix");
      expect(caps.coding).toBe(true);
      expect(caps.vision).toBe(true);
    });
  });

  describe("getModelCapabilitiesFromCatalog", () => {
    it("uses catalog metadata for vision", () => {
      const entry: ModelCatalogEntry = {
        id: "some-model",
        name: "Some Model",
        provider: "some-provider",
        input: ["text", "image"],
      };
      const caps = getModelCapabilitiesFromCatalog(entry);
      expect(caps.vision).toBe(true);
    });

    it("uses catalog metadata for reasoning", () => {
      const entry: ModelCatalogEntry = {
        id: "some-model",
        name: "Some Model",
        provider: "some-provider",
        reasoning: true,
      };
      const caps = getModelCapabilitiesFromCatalog(entry);
      expect(caps.reasoning).toBe(true);
    });

    it("combines registry and catalog data", () => {
      const entry: ModelCatalogEntry = {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        provider: "anthropic",
        reasoning: true,
        input: ["text", "image"],
      };
      const caps = getModelCapabilitiesFromCatalog(entry);
      expect(caps.coding).toBe(true);
      expect(caps.reasoning).toBe(true);
      expect(caps.vision).toBe(true);
    });
  });

  describe("filterByCapability", () => {
    const catalog: ModelCatalogEntry[] = [
      { id: "claude-opus-4-5", name: "Claude Opus", provider: "anthropic", reasoning: true },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
      {
        id: "gemini-2.0-flash",
        name: "Gemini Flash",
        provider: "google",
        input: ["text", "image"],
      },
    ];

    it("filters by coding capability", () => {
      const coding = filterByCapability(catalog, "coding");
      expect(coding.length).toBe(3);
    });

    it("filters by reasoning capability", () => {
      const reasoning = filterByCapability(catalog, "reasoning");
      expect(reasoning.some((m) => m.id === "claude-opus-4-5")).toBe(true);
    });

    it("filters by fast capability", () => {
      const fast = filterByCapability(catalog, "fast");
      expect(fast.some((m) => m.id === "gpt-4o-mini")).toBe(true);
      expect(fast.some((m) => m.id === "gemini-2.0-flash")).toBe(true);
    });
  });

  describe("convenience filter functions", () => {
    const catalog: ModelCatalogEntry[] = [
      { id: "claude-opus-4-5", name: "Claude Opus", provider: "anthropic", reasoning: true },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", input: ["text", "image"] },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
    ];

    it("getCodingModels returns coding-capable models", () => {
      const result = getCodingModels(catalog);
      expect(result.length).toBeGreaterThan(0);
    });

    it("getReasoningModels returns reasoning-capable models", () => {
      const result = getReasoningModels(catalog);
      expect(result.some((m) => m.id === "claude-opus-4-5")).toBe(true);
    });

    it("getVisionModels returns vision-capable models", () => {
      const result = getVisionModels(catalog);
      expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    });

    it("getFastModels returns fast models", () => {
      const result = getFastModels(catalog);
      expect(result.some((m) => m.id === "gpt-4o-mini")).toBe(true);
    });
  });

  describe("getModelsByTier", () => {
    const catalog: ModelCatalogEntry[] = [
      { id: "claude-opus-4-5", name: "Claude Opus", provider: "anthropic" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
    ];

    it("filters by powerful tier", () => {
      const result = getModelsByTier(catalog, "powerful");
      expect(result.some((m) => m.id === "claude-opus-4-5")).toBe(true);
    });

    it("filters by fast tier", () => {
      const result = getModelsByTier(catalog, "fast");
      expect(result.some((m) => m.id === "gpt-4o-mini")).toBe(true);
    });

    it("filters by balanced tier", () => {
      const result = getModelsByTier(catalog, "balanced");
      expect(result.some((m) => m.id === "gpt-4o")).toBe(true);
    });
  });

  describe("getModelsByCostTier", () => {
    const catalog: ModelCatalogEntry[] = [
      { id: "claude-opus-4-5", name: "Claude Opus", provider: "anthropic" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
    ];

    it("filters by expensive tier", () => {
      const result = getModelsByCostTier(catalog, "expensive");
      expect(result.some((m) => m.id === "claude-opus-4-5")).toBe(true);
    });

    it("filters by cheap tier", () => {
      const result = getModelsByCostTier(catalog, "cheap");
      expect(result.some((m) => m.id === "gpt-4o-mini")).toBe(true);
    });
  });

  describe("getCapabilityTags", () => {
    it("returns tags for a model", () => {
      const entry: ModelCatalogEntry = {
        id: "claude-opus-4-5",
        name: "Claude Opus",
        provider: "anthropic",
        reasoning: true,
        input: ["text", "image"],
      };
      const tags = getCapabilityTags(entry);
      expect(tags).toContain("coding");
      expect(tags).toContain("reasoning");
      expect(tags).toContain("vision");
      expect(tags).toContain("creative");
    });

    it("returns minimal tags for basic models", () => {
      const entry: ModelCatalogEntry = {
        id: "unknown-model",
        name: "Unknown",
        provider: "unknown",
      };
      const tags = getCapabilityTags(entry);
      expect(tags.length).toBe(0);
    });
  });

  describe("enrichCatalogWithCapabilities", () => {
    it("adds capabilities and tags to catalog entries", () => {
      const catalog: ModelCatalogEntry[] = [
        { id: "claude-opus-4-5", name: "Claude Opus", provider: "anthropic" },
        { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
      ];

      const enriched = enrichCatalogWithCapabilities(catalog);

      expect(enriched[0].capabilities).toBeDefined();
      expect(enriched[0].capabilities.coding).toBe(true);
      expect(enriched[0].tags).toContain("coding");

      expect(enriched[1].capabilities).toBeDefined();
      expect(enriched[1].capabilities.fast).toBe(true);
      expect(enriched[1].tags).toContain("fast");
    });
  });

  describe("MODEL_CAPABILITIES_REGISTRY", () => {
    it("has entries for major providers", () => {
      const providers = new Set(
        Object.keys(MODEL_CAPABILITIES_REGISTRY).map((id) => {
          if (id.startsWith("claude")) {
            return "anthropic";
          }
          if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3")) {
            return "openai";
          }
          if (id.startsWith("gemini")) {
            return "google";
          }
          if (id.startsWith("llama") || id.startsWith("mixtral")) {
            return "groq";
          }
          if (id.startsWith("mistral") || id.startsWith("codestral")) {
            return "mistral";
          }
          if (id.startsWith("deepseek")) {
            return "deepseek";
          }
          if (id.startsWith("grok")) {
            return "xai";
          }
          if (id.startsWith("command")) {
            return "cohere";
          }
          return "other";
        }),
      );

      expect(providers.has("anthropic")).toBe(true);
      expect(providers.has("openai")).toBe(true);
      expect(providers.has("google")).toBe(true);
    });

    it("has valid capability structure for all entries", () => {
      for (const [modelId, caps] of Object.entries(MODEL_CAPABILITIES_REGISTRY)) {
        expect(typeof modelId).toBe("string");
        expect(modelId.length).toBeGreaterThan(0);

        if (caps.performanceTier) {
          expect(["fast", "balanced", "powerful"]).toContain(caps.performanceTier);
        }
        if (caps.costTier) {
          expect(["free", "cheap", "moderate", "expensive"]).toContain(caps.costTier);
        }
      }
    });
  });
});
