import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("OpenAI model materialization", () => {
  it.each(["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"])(
    "materializes %s with its own capabilities without rewriting the alias",
    (modelId) => {
      const provider = buildOpenAIProvider();
      const model = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId,
        modelRegistry: { find: () => null },
      } as never);
      expect(model).toMatchObject({
        id: modelId,
        provider: "openai",
        api: "openai-responses",
        compat: { supportedReasoningEfforts: expect.arrayContaining(["xhigh", "max"]) },
      });
    },
  );

  it.each(["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"])(
    "preserves the registered %s row and its configured Ultra opt-out",
    (modelId) => {
      const provider = buildOpenAIProvider();
      const initialModel = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId,
        modelRegistry: { find: () => null },
      } as never);
      const registeredModel = {
        ...initialModel,
        contextWindow: 123_456,
        thinkingLevelMap: { max: null },
      };
      const resolvedModel = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId,
        modelRegistry: { find: () => registeredModel },
      } as never);
      expect(resolvedModel).toBe(registeredModel);
      expect(
        resolveThinkingProfile({
          provider: "openai",
          modelId,
          agentRuntime: "openclaw",
          compat: resolvedModel?.compat,
          thinkingLevelMap: resolvedModel?.thinkingLevelMap,
        })?.levels.map(({ id }) => id),
      ).not.toContain("ultra");
    },
  );

  it("routes GPT forward-compat models by the projected route, not profile order", () => {
    const provider = buildOpenAIProvider();

    const openaiModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      providerConfig: {
        auth: "api-key",
      },
    } as never);
    const unselectedPlatformModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.6",
      modelRegistry: { find: () => null },
      authProfileId: "openai:oauth",
      authProfileMode: "oauth",
      config: {
        auth: {
          profiles: {
            "openai:oauth": {
              provider: "openai",
              mode: "oauth",
            },
            "openai:api-key": {
              provider: "openai",
              mode: "api_key",
            },
          },
          order: {
            openai: ["openai:oauth", "openai:api-key"],
          },
        },
      },
    } as never);
    const unprojectedOauthModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      authProfileId: "openai:oauth",
      authProfileMode: "oauth",
    } as never);
    const selectedOauthModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      authProfileId: "openai:work",
      authProfileMode: "oauth",
      providerConfig: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    } as never);

    expect(openaiModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
    expect(unselectedPlatformModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.6",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
    expect(unprojectedOauthModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(selectedOauthModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });
});
