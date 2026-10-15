import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

function modelRegistry(
  models: ProviderRuntimeModel[] = [],
): ProviderResolveDynamicModelContext["modelRegistry"] {
  return {
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    getAll: () => models,
    getAvailable: () => models,
    hasConfiguredAuth: () => false,
  };
}

describe("OpenAI dynamic model capabilities", () => {
  it.each([
    {
      api: "openai-chatgpt-responses" as const,
      id: "gpt-6.1-sol",
      off: null,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      cost: {
        input: 2,
        output: 10,
        cacheRead: 0.1,
        cacheWrite: 2.5,
      },
    },
    {
      api: "openai-chatgpt-responses" as const,
      id: "gpt-6-sol",
      off: "none",
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
      cost: {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite: 2.5,
      },
    },
  ])("resolves $id with its own capabilities over $api", ({ api, id, off, efforts, cost }) => {
    const model = buildOpenAIProvider().resolveDynamicModel?.({
      provider: "openai",
      modelId: id,
      providerConfig: {
        api,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        models: [],
      },
      modelRegistry: modelRegistry(),
    });

    expect(model).toMatchObject({
      id,
      provider: "openai",
      api,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      contextTokens: api === "openai-chatgpt-responses" && id === "gpt-6.1-sol" ? 500_000 : 272_000,
      maxTokens: 128_000,
      cost,
      thinkingLevelMap: { off, minimal: "low", xhigh: "xhigh", max: "max" },
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: efforts,
        supportsTemperature: false,
        codeMode: "preferred",
      },
    });
  });

  it.each([700_000])("preserves GPT-6.1 Sol subscription context override %s", (contextTokens) => {
    const exact: ProviderRuntimeModel = {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      provider: "openai",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      contextWindow: 1_050_000,
      contextTokens,
      maxTokens: 128_000,
    };
    const model = buildOpenAIProvider().resolveDynamicModel?.({
      provider: "openai",
      modelId: exact.id,
      providerConfig: {
        api: "openai-chatgpt-responses",
        baseUrl: exact.baseUrl,
        models: [],
      },
      modelRegistry: modelRegistry([exact]),
    });
    expect(model?.contextTokens).toBe(contextTokens);
  });

  it("does not inherit a different model's Code Mode opt-out", () => {
    const template: ProviderRuntimeModel = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      compat: { codeMode: "capable" },
    };
    const model = buildOpenAIProvider().resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.5",
      modelRegistry: modelRegistry([template]),
    });
    expect(model?.compat?.codeMode).toBe("preferred");
  });

  it.each(["openai-responses"] as const)(
    "constructs %s models without adding the template's transport defaults",
    (api) => {
      const template: ProviderRuntimeModel = {
        id: "gpt-5.4",
        name: "Template",
        provider: "openai",
        api: "openai-completions",
        baseUrl: "https://template.example/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { "X-Template": "preserved" },
        compat: { supportsDeveloperRole: true, codeMode: "capable" },
      };
      const original = structuredClone(template);
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId: template.id,
        providerConfig: {
          api,
          baseUrl:
            api === "openai-responses"
              ? "https://api.openai.com/v1"
              : "https://chatgpt.com/backend-api/codex",
          models: [],
        },
        modelRegistry: modelRegistry([template]),
      });

      expect(model).not.toBe(template);
      expect(model).toMatchObject({ id: template.id, api, headers: original.headers });
      expect(model?.compat).toEqual(original.compat);
      expect(template).toEqual(original);
    },
  );

  // The API-key listing hides these families; config defaults and session overrides still name them.
  it.each([["o3", true]] as const)(
    "resolves the selected pre-GPT-5 ref %s with listing metadata",
    (id, reasoning) => {
      const model = buildOpenAIProvider().resolveDynamicModel?.({
        provider: "openai",
        modelId: id,
        modelRegistry: modelRegistry(),
      });
      expect(model).toEqual({
        id,
        name: id,
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      });
    },
  );
});
