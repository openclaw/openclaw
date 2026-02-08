import { describe, expect, it, vi } from "vitest";
import {
  generateFriendlyModelName,
  HUAWEI_MAAS_DEFAULT_MODELS,
  HUAWEI_MAAS_DEFAULT_COST,
  HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW,
  HUAWEI_MAAS_DEFAULT_MAX_TOKENS,
} from "./huawei-maas-models.js";
import { buildHuaweiMaasProvider, discoverHuaweiMaasModels } from "./models-config.providers.js";

describe("Huawei MAAS models", () => {
  describe("generateFriendlyModelName", () => {
    it("should generate friendly model name from model ID", () => {
      expect(generateFriendlyModelName("deepseek-v3.2")).toBe("Deepseek V3 2");
      expect(generateFriendlyModelName("Kimi-K2")).toBe("Kimi K2");
      expect(generateFriendlyModelName("qwen3-32b")).toBe("Qwen3 32b");
      expect(generateFriendlyModelName("deepseek-r1-250528")).toBe("Deepseek R1 250528");
    });
  });

  describe("HUAWEI_MAAS_DEFAULT_MODELS", () => {
    it("should have correct default models", () => {
      expect(HUAWEI_MAAS_DEFAULT_MODELS).toBeDefined();
      expect(Array.isArray(HUAWEI_MAAS_DEFAULT_MODELS)).toBe(true);
      expect(HUAWEI_MAAS_DEFAULT_MODELS.length).toBeGreaterThan(0);

      // Check that all models have required properties
      HUAWEI_MAAS_DEFAULT_MODELS.forEach((model) => {
        expect(model.id).toBeDefined();
        expect(model.name).toBeDefined();
        expect(model.reasoning).toBeDefined();
        expect(model.input).toBeDefined();
        expect(Array.isArray(model.input)).toBe(true);
        expect(model.cost).toBeDefined();
        expect(model.contextWindow).toBeDefined();
        expect(model.maxTokens).toBeDefined();

        // Check that cost matches default cost
        expect(model.cost).toEqual(HUAWEI_MAAS_DEFAULT_COST);

        // Check that context window and max tokens match defaults
        expect(model.contextWindow).toBe(HUAWEI_MAAS_DEFAULT_CONTEXT_WINDOW);
        expect(model.maxTokens).toBe(HUAWEI_MAAS_DEFAULT_MAX_TOKENS);
      });

      // Check for specific models
      expect(HUAWEI_MAAS_DEFAULT_MODELS.some((model) => model.id === "deepseek-v3.2")).toBe(true);
      expect(HUAWEI_MAAS_DEFAULT_MODELS.some((model) => model.id === "Kimi-K2")).toBe(true);
      expect(HUAWEI_MAAS_DEFAULT_MODELS.some((model) => model.id === "qwen3-32b")).toBe(true);
    });
  });

  describe("buildHuaweiMaasProvider", () => {
    it("should return provider config with default models when no API key is provided", async () => {
      const provider = await buildHuaweiMaasProvider();

      expect(provider).toBeDefined();
      expect(provider.baseUrl).toBe("https://api.modelarts-maas.com");
      expect(provider.api).toBe("openai-completions");
      expect(provider.models).toBeDefined();
      expect(Array.isArray(provider.models)).toBe(true);
      expect(provider.models.length).toBeGreaterThan(0);

      // Should not include apiKey when no API key is provided
      expect(provider.apiKey).toBeUndefined();
    });

    it("should return provider config with API key when provided", async () => {
      const apiKey = "test-api-key";
      const provider = await buildHuaweiMaasProvider(apiKey);

      expect(provider).toBeDefined();
      expect(provider.baseUrl).toBe("https://api.modelarts-maas.com");
      expect(provider.api).toBe("openai-completions");
      expect(provider.apiKey).toBe(apiKey);
      expect(provider.models).toBeDefined();
      expect(Array.isArray(provider.models)).toBe(true);
      expect(provider.models.length).toBeGreaterThan(0);
    });
  });

  describe("discoverHuaweiMaasModels", () => {
    it("should return empty array in test environment", async () => {
      // Mock test environment
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";

      const models = await discoverHuaweiMaasModels("test-api-key");
      expect(models).toEqual([]);

      // Restore original environment
      process.env.NODE_ENV = originalNodeEnv;
    });

    it("should return empty array when API call fails", async () => {
      // Mock fetch to simulate API failure
      const originalFetch = global.fetch;
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
        }),
      ) as unknown as typeof global.fetch;

      const models = await discoverHuaweiMaasModels("test-api-key");
      expect(models).toEqual([]);

      // Restore original fetch
      global.fetch = originalFetch;
    });

    it("should return models when API call succeeds", async () => {
      // Save original environment variables
      const originalVitest = process.env.VITEST;
      const originalNodeEnv = process.env.NODE_ENV;

      // Temporarily disable test environment detection
      delete process.env.VITEST;
      process.env.NODE_ENV = "development";

      // Mock fetch to simulate API success
      const originalFetch = global.fetch;
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              object: "list",
              data: [
                {
                  id: "test-model",
                  object: "list",
                  created: 0,
                  owned_by: "system",
                },
              ],
            }),
        }),
      ) as unknown as typeof global.fetch;

      const models = await discoverHuaweiMaasModels("test-api-key");
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBe(1);
      expect(models[0].id).toBe("test-model");
      expect(models[0].name).toBeDefined();

      // Restore original fetch
      global.fetch = originalFetch;

      // Restore original environment variables
      process.env.VITEST = originalVitest;
      process.env.NODE_ENV = originalNodeEnv;
    });
  });
});
