import { describe, expect, it } from "vitest";
import { buildAzureOpenAIProvider } from "./models-config.providers.js";

describe("Azure OpenAI provider", () => {
  describe("buildAzureOpenAIProvider", () => {
    it("generates native Azure provider config", () => {
      const provider = buildAzureOpenAIProvider({
        endpoint: "https://my-resource.openai.azure.com",
        apiKey: "test-key",
        deployments: {
          "gpt-4o-mini": "my-gpt4o-deployment",
          "gpt-5.2-codex": "my-gpt5-deployment",
        },
      });

      expect(provider.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
      expect(provider.apiKey).toBe("test-key");
      expect(provider.api).toBe("azure-openai-responses");
      expect(provider.models).toHaveLength(2);

      const gpt4Model = provider.models.find((m) => m.id === "my-gpt4o-deployment");
      expect(gpt4Model).toBeDefined();
      expect(gpt4Model?.name).toBe("gpt-4o-mini");

      const gpt5Model = provider.models.find((m) => m.id === "my-gpt5-deployment");
      expect(gpt5Model).toBeDefined();
      expect(gpt5Model?.contextWindow).toBe(200000);
    });

    it("strips trailing slash from endpoint", () => {
      const provider = buildAzureOpenAIProvider({
        endpoint: "https://my-resource.openai.azure.com/",
        deployments: { "gpt-4o": "deploy" },
      });

      expect(provider.baseUrl).toBe("https://my-resource.openai.azure.com/openai/v1");
    });

    it("detects reasoning models (o1, o3)", () => {
      const provider = buildAzureOpenAIProvider({
        endpoint: "https://test.openai.azure.com",
        deployments: {
          "o1-preview": "o1-deploy",
          "o3-mini": "o3-deploy",
          "gpt-4o": "gpt4-deploy",
        },
      });

      const o1Model = provider.models.find((m) => m.id === "o1-deploy");
      expect(o1Model?.reasoning).toBe(true);

      const o3Model = provider.models.find((m) => m.id === "o3-deploy");
      expect(o3Model?.reasoning).toBe(true);

      const gptModel = provider.models.find((m) => m.id === "gpt4-deploy");
      expect(gptModel?.reasoning).toBe(false);
    });

    it("sets supportsStore to false for Azure models", () => {
      const provider = buildAzureOpenAIProvider({
        endpoint: "https://test.openai.azure.com",
        deployments: { "gpt-4o": "deploy" },
      });

      expect(provider.models[0]?.compat?.supportsStore).toBe(false);
    });
  });
});
