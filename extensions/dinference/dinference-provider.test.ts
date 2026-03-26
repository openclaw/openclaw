import OpenAI from "openai";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/core";
import {
  DINFERENCE_BASE_URL,
  DINFERENCE_MODEL_CATALOG,
  buildDinferenceModelDefinition,
} from "openclaw/plugin-sdk/provider-models";
import { describe, expect, it } from "vitest";
import { capturePluginRegistration } from "../../test/helpers/extensions/plugin-registration.js";
import pluginEntry from "./index.js";
import { applyDinferenceConfig, DINFERENCE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildDinferenceProvider } from "./provider-catalog.js";

const DINFERENCE_API_KEY = process.env.DINFERENCE_API_KEY ?? "";
const liveEnabled = DINFERENCE_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

function createCatalogContext(
  config: ProviderCatalogContext["config"] = {},
): ProviderCatalogContext {
  return {
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    resolveProviderAuth: () => ({
      apiKey: "test-key",
      mode: "api_key",
      source: "env",
    }),
  };
}

describe("DInference Provider", () => {
  describe("Provider registration", () => {
    it("registers provider with correct metadata", () => {
      const captured = capturePluginRegistration(pluginEntry);
      expect(captured.providers).toHaveLength(1);

      const provider = captured.providers[0];
      expect(provider).toMatchObject({
        id: "dinference",
        label: "DInference",
        docsPath: "/providers/dinference",
        envVars: ["DINFERENCE_API_KEY"],
      });
    });

    it("configures API key authentication", () => {
      const captured = capturePluginRegistration(pluginEntry);
      const provider = captured.providers[0];

      expect(provider?.auth).toHaveLength(1);
      expect(provider?.auth[0]).toMatchObject({
        id: "api-key",
        label: "DInference API key",
        hint: "Open source models (GLM-5, GLM-4.7, GPT-OSS-120b)",
      });
    });

    it("configures wizard metadata", () => {
      const captured = capturePluginRegistration(pluginEntry);
      const provider = captured.providers[0];

      expect(provider?.auth[0]?.wizard).toMatchObject({
        choiceId: "dinference-api-key",
        choiceLabel: "DInference API key",
        groupId: "dinference",
        groupLabel: "DInference",
        groupHint: "Open source models (GLM-5, GLM-4.7, GPT-OSS-120b)",
        methodId: "api-key",
      });
    });

    it("registers provider catalog", async () => {
      const captured = capturePluginRegistration(pluginEntry);
      const provider = captured.providers[0];

      const catalog = await provider?.catalog?.run(createCatalogContext());
      expect(catalog).toBeDefined();

      if (catalog && "provider" in catalog && catalog.provider) {
        expect(catalog.provider).toMatchObject({
          api: "openai-completions",
          baseUrl: DINFERENCE_BASE_URL,
          apiKey: "test-key",
        });
      }
    });
  });

  describe("Model catalog building", () => {
    it("returns valid provider config", () => {
      const provider = buildDinferenceProvider();

      expect(provider).toBeDefined();
      expect(provider.baseUrl).toBe(DINFERENCE_BASE_URL);
      expect(provider.api).toBe("openai-completions");
      expect(provider.models).toBeDefined();
      expect(Array.isArray(provider.models)).toBe(true);
    });

    it("includes all DInference models in catalog", () => {
      const provider = buildDinferenceProvider();

      expect(provider.models).toHaveLength(DINFERENCE_MODEL_CATALOG.length);
      const modelIds = provider.models.map((m) => m.id);
      expect(modelIds).toContain("glm-5");
      expect(modelIds).toContain("glm-4.7");
      expect(modelIds).toContain("gpt-oss-120b");
    });

    it("builds model definitions with required fields", () => {
      const model = DINFERENCE_MODEL_CATALOG[0];
      const definition = buildDinferenceModelDefinition(model);

      expect(definition).toMatchObject({
        id: model.id,
        name: model.name,
        api: "openai-completions",
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      });
    });

    it("GLM 5 model has correct catalog entry", () => {
      const provider = buildDinferenceProvider();
      const glm5 = provider.models.find((m) => m.id === "glm-5");

      expect(glm5).toBeDefined();
      expect(glm5?.name).toBe("GLM 5");
      expect(glm5?.reasoning).toBe(true);
      expect(glm5?.input).toEqual(["text"]);
      expect(glm5?.contextWindow).toBe(200000);
      expect(glm5?.maxTokens).toBe(128000);
    });

    it("GLM 4.7 model has correct catalog entry", () => {
      const provider = buildDinferenceProvider();
      const glm47 = provider.models.find((m) => m.id === "glm-4.7");

      expect(glm47).toBeDefined();
      expect(glm47?.name).toBe("GLM 4.7");
      expect(glm47?.reasoning).toBe(true);
      expect(glm47?.input).toEqual(["text"]);
      expect(glm47?.contextWindow).toBe(200000);
      expect(glm47?.maxTokens).toBe(128000);
    });

    it("GPT-OSS-120B model has correct catalog entry", () => {
      const provider = buildDinferenceProvider();
      const gptOss = provider.models.find((m) => m.id === "gpt-oss-120b");

      expect(gptOss).toBeDefined();
      expect(gptOss?.name).toBe("GPT-OSS 120B");
      expect(gptOss?.reasoning).toBe(false);
      expect(gptOss?.input).toEqual(["text"]);
      expect(gptOss?.contextWindow).toBe(131072);
      expect(gptOss?.maxTokens).toBe(32768);
    });
  });

  describe("Onboard config appliers", () => {
    it("has correct default model ID", () => {
      expect(DINFERENCE_DEFAULT_MODEL_REF).toBe("dinference/glm-5");
    });

    it("applyDinferenceConfig returns config object", () => {
      const result = applyDinferenceConfig({});

      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
    });

    it("applyDinferenceConfig configures provider and default model", () => {
      const result = applyDinferenceConfig({});

      expect(result.models?.providers?.dinference).toBeDefined();
      expect(result.agents?.defaults?.model).toEqual({
        primary: DINFERENCE_DEFAULT_MODEL_REF,
      });
    });

    it("provider config has correct API settings", () => {
      const result = applyDinferenceConfig({});
      const provider = result.models?.providers?.dinference;

      expect(provider).toBeDefined();
      expect(provider?.api).toBe("openai-completions");
      expect(provider?.baseUrl).toBe(DINFERENCE_BASE_URL);
    });

    it("provider config includes model catalog", () => {
      const result = applyDinferenceConfig({});
      const provider = result.models?.providers?.dinference;

      expect(provider).toBeDefined();
      expect(provider?.models).toBeDefined();
      expect(Array.isArray(provider?.models)).toBe(true);
      expect(provider?.models).toHaveLength(DINFERENCE_MODEL_CATALOG.length);
    });

    it("config includes model alias in agent defaults", () => {
      const result = applyDinferenceConfig({});
      const agentModels = result.agents?.defaults?.models;

      expect(agentModels).toBeDefined();
      expect(agentModels?.[DINFERENCE_DEFAULT_MODEL_REF]).toMatchObject({
        alias: "DInference",
      });
    });

    it("preserves existing aliases when applying config", () => {
      const result = applyDinferenceConfig({
        agents: {
          defaults: {
            models: {
              "dinference/glm-5": {
                alias: "Existing Alias",
              },
            },
          },
        },
      });

      expect(result.agents?.defaults?.models?.["dinference/glm-5"]).toMatchObject({
        alias: "Existing Alias",
      });
    });
  });

  describe("Integration", () => {
    it("plugin catalog produces same models as buildDinferenceProvider", async () => {
      const captured = capturePluginRegistration(pluginEntry);
      const provider = captured.providers[0];

      const catalog = await provider?.catalog?.run(createCatalogContext());
      const directProvider = buildDinferenceProvider();

      let catalogModels: typeof directProvider.models | undefined;
      if (catalog && "provider" in catalog && catalog.provider) {
        catalogModels = catalog.provider.models;
      } else if (catalog && "providers" in catalog && catalog.providers) {
        const dinference = catalog.providers.dinference;
        if (dinference) {
          catalogModels = dinference.models;
        }
      }

      expect(catalogModels).toBeDefined();
      expect(catalogModels).toHaveLength(directProvider.models.length);
      expect(catalogModels?.map((m) => m.id)).toEqual(directProvider.models.map((m) => m.id));
    });
  });

  describeLive("DInference live API", () => {
    it("connects to DInference API and lists models", async () => {
      const client = new OpenAI({
        apiKey: DINFERENCE_API_KEY,
        baseURL: DINFERENCE_BASE_URL,
      });

      const models = await client.models.list();
      const modelIds = models.data.map((m) => m.id);

      expect(modelIds.length).toBeGreaterThan(0);
      expect(modelIds).toContain("glm-5");
    });

    it("completes chat with glm-5 model", async () => {
      const client = new OpenAI({
        apiKey: DINFERENCE_API_KEY,
        baseURL: DINFERENCE_BASE_URL,
      });

      const response = await client.chat.completions.create({
        model: "glm-5",
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        max_tokens: 256,
      });

      expect(response.choices).toHaveLength(1);
      expect(response.choices[0]?.message?.content?.trim()).toMatch(/^OK[.!]?$/);
    }, 30000);

    it("completes chat with glm-4.7 model", async () => {
      const client = new OpenAI({
        apiKey: DINFERENCE_API_KEY,
        baseURL: DINFERENCE_BASE_URL,
      });

      const response = await client.chat.completions.create({
        model: "glm-4.7",
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        max_tokens: 256,
      });

      expect(response.choices).toHaveLength(1);
      expect(response.choices[0]?.message?.content?.trim()).toMatch(/^OK[.!]?$/);
    }, 30000);
  });
});
