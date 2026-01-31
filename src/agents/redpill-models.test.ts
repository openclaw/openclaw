import { describe, expect, it, beforeEach } from "vitest";
import {
  REDPILL_GPU_TEE_CATALOG,
  REDPILL_DEFAULT_MODEL,
  REDPILL_DEFAULT_MODEL_REF,
  REDPILL_BASE_URL,
  discoverRedpillModels,
  resetRedpillModelCache,
} from "./redpill-models.js";

describe("Redpill Models", () => {
  beforeEach(() => {
    resetRedpillModelCache();
  });

  describe("Constants", () => {
    it("should have correct base URL", () => {
      expect(REDPILL_BASE_URL).toBe("https://api.redpill.ai/v1");
    });

    it("should have correct default model", () => {
      expect(REDPILL_DEFAULT_MODEL).toBe("deepseek/deepseek-v3.2");
    });

    it("should have correct default model reference", () => {
      expect(REDPILL_DEFAULT_MODEL_REF).toBe("redpill/deepseek/deepseek-v3.2");
    });
  });

  describe("GPU TEE Catalog", () => {
    it("should have exactly 19 models", () => {
      expect(REDPILL_GPU_TEE_CATALOG).toHaveLength(19);
    });

    it("should have 10 Phala models", () => {
      const phalaModels = [
        "z-ai/glm-4.7-flash",
        "qwen/qwen3-embedding-8b",
        "phala/uncensored-24b",
        "deepseek/deepseek-v3.2",
        "qwen/qwen3-vl-30b-a3b-instruct",
        "sentence-transformers/all-minilm-l6-v2",
        "qwen/qwen-2.5-7b-instruct",
        "google/gemma-3-27b-it",
        "openai/gpt-oss-120b",
        "openai/gpt-oss-20b",
      ];
      const catalogIds = REDPILL_GPU_TEE_CATALOG.map((m) => m.id);
      for (const id of phalaModels) {
        expect(catalogIds).toContain(id);
      }
    });

    it("should have 4 Tinfoil models", () => {
      const tinfoilModels = [
        "moonshotai/kimi-k2-thinking",
        "deepseek/deepseek-r1-0528",
        "qwen/qwen3-coder-480b-a35b-instruct",
        "meta-llama/llama-3.3-70b-instruct",
      ];
      const catalogIds = REDPILL_GPU_TEE_CATALOG.map((m) => m.id);
      for (const id of tinfoilModels) {
        expect(catalogIds).toContain(id);
      }
    });

    it("should have 2 Chutes models", () => {
      const chutesModels = ["moonshotai/kimi-k2.5", "minimax/minimax-m2.1"];
      const catalogIds = REDPILL_GPU_TEE_CATALOG.map((m) => m.id);
      for (const id of chutesModels) {
        expect(catalogIds).toContain(id);
      }
    });

    it("should have 3 Near-AI models", () => {
      const nearModels = [
        "deepseek/deepseek-chat-v3.1",
        "qwen/qwen3-30b-a3b-instruct-2507",
        "z-ai/glm-4.7",
      ];
      const catalogIds = REDPILL_GPU_TEE_CATALOG.map((m) => m.id);
      for (const id of nearModels) {
        expect(catalogIds).toContain(id);
      }
    });

    it("should have correct reasoning models", () => {
      const reasoningModels = REDPILL_GPU_TEE_CATALOG.filter((m) => m.reasoning);
      expect(reasoningModels).toHaveLength(2);
      expect(reasoningModels.map((m) => m.id)).toEqual([
        "moonshotai/kimi-k2-thinking",
        "deepseek/deepseek-r1-0528",
      ]);
    });

    it("should have correct vision models", () => {
      const visionModels = REDPILL_GPU_TEE_CATALOG.filter((m) => m.input.includes("image"));
      expect(visionModels).toHaveLength(2);
      expect(visionModels.map((m) => m.id).sort()).toEqual([
        "moonshotai/kimi-k2.5",
        "qwen/qwen3-vl-30b-a3b-instruct",
      ]);
    });

    it("should have valid structure for all entries", () => {
      for (const entry of REDPILL_GPU_TEE_CATALOG) {
        expect(entry).toMatchObject({
          id: expect.any(String),
          name: expect.stringContaining("GPU TEE"),
          reasoning: expect.any(Boolean),
          input: expect.arrayContaining([expect.any(String)]),
          contextWindow: expect.any(Number),
          cost: { input: expect.any(Number), output: expect.any(Number) },
        });

        expect(entry.contextWindow).toBeGreaterThan(0);
        expect(entry.input.length).toBeGreaterThan(0);
      }
    });

    it("should include default model in catalog", () => {
      const defaultModel = REDPILL_GPU_TEE_CATALOG.find((m) => m.id === REDPILL_DEFAULT_MODEL);
      expect(defaultModel).toBeDefined();
      expect(defaultModel?.name).toBe("DeepSeek v3.2 (GPU TEE)");
    });
  });

  describe("discoverRedpillModels", () => {
    it("should convert catalog to model definitions", () => {
      const models = discoverRedpillModels();
      expect(models).toHaveLength(19);

      for (const model of models) {
        expect(model).toMatchObject({
          id: expect.any(String),
          name: expect.any(String),
          contextWindow: expect.any(Number),
          maxTokens: expect.any(Number),
          cost: {
            input: expect.any(Number),
            output: expect.any(Number),
            cacheRead: 0,
            cacheWrite: 0,
          },
          input: expect.arrayContaining([expect.any(String)]),
          reasoning: expect.any(Boolean),
        });
        // maxTokens should be 80% of contextWindow
        expect(model.maxTokens).toBe(Math.floor(model.contextWindow * 0.8));
      }
    });

    it("should cache results", () => {
      const models1 = discoverRedpillModels();
      const models2 = discoverRedpillModels();
      expect(models1).toBe(models2); // Same reference
    });

    it("should return fresh data after cache reset", () => {
      const models1 = discoverRedpillModels();
      resetRedpillModelCache();
      const models2 = discoverRedpillModels();
      expect(models1).not.toBe(models2); // Different reference
      expect(models1).toEqual(models2); // Same content
    });
  });

  describe("Model Details", () => {
    it("should have correct embedding model configuration", () => {
      const embeddingModel = REDPILL_GPU_TEE_CATALOG.find(
        (m) => m.id === "sentence-transformers/all-minilm-l6-v2",
      );
      expect(embeddingModel).toBeDefined();
      expect(embeddingModel?.contextWindow).toBe(512);
    });

    it("should have correct cost for tinfoil models", () => {
      const kimi = REDPILL_GPU_TEE_CATALOG.find((m) => m.id === "moonshotai/kimi-k2-thinking");
      expect(kimi?.cost).toEqual({ input: 2.0, output: 2.0 });
    });

    it("should have correct cost for kimi k2.5", () => {
      const kimi = REDPILL_GPU_TEE_CATALOG.find((m) => m.id === "moonshotai/kimi-k2.5");
      expect(kimi?.cost).toEqual({ input: 0.6, output: 3.0 });
    });

    it("should have correct context windows", () => {
      const testCases: Array<{ id: string; contextWindow: number }> = [
        { id: "z-ai/glm-4.7-flash", contextWindow: 203_000 },
        { id: "qwen/qwen3-embedding-8b", contextWindow: 33_000 },
        { id: "deepseek/deepseek-v3.2", contextWindow: 164_000 },
        { id: "qwen/qwen3-vl-30b-a3b-instruct", contextWindow: 128_000 },
        { id: "moonshotai/kimi-k2-thinking", contextWindow: 262_000 },
        { id: "minimax/minimax-m2.1", contextWindow: 197_000 },
      ];

      for (const { id, contextWindow } of testCases) {
        const model = REDPILL_GPU_TEE_CATALOG.find((m) => m.id === id);
        expect(model?.contextWindow).toBe(contextWindow);
      }
    });
  });
});
