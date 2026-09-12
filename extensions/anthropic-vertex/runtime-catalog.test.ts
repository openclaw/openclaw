import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicVertexPlugin from "./index.js";

describe("Anthropic Vertex registered runtime model resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    {
      region: "us-central1",
      modelId: "claude-sonnet-4-6",
      baseUrl: undefined,
      expectedUrl: "https://us-central1-aiplatform.googleapis.com",
      inputCost: 3,
    },
    {
      region: "us-central1",
      modelId: "claude-sonnet-4-6",
      baseUrl: "",
      expectedUrl: "https://us-central1-aiplatform.googleapis.com",
      inputCost: 3,
    },
    {
      region: "eu",
      modelId: "claude-sonnet-5",
      baseUrl: undefined,
      expectedUrl: "https://aiplatform.eu.rep.googleapis.com",
      inputCost: 2.2,
    },
    {
      region: "us-central1",
      modelId: "claude-sonnet-5",
      baseUrl: "https://aiplatform.googleapis.com",
      expectedUrl: "https://aiplatform.googleapis.com",
      inputCost: 2,
    },
  ])(
    "resolves missing $modelId using $region and $baseUrl",
    async ({ region, modelId, baseUrl, expectedUrl, inputCost }) => {
      vi.stubEnv("GOOGLE_CLOUD_LOCATION", region);
      const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
      const model = provider.resolveDynamicModel?.({
        provider: "anthropic-vertex",
        modelId,
        modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
        providerConfig: { baseUrl },
      });

      expect(model).toMatchObject({
        id: modelId,
        provider: "anthropic-vertex",
        api: "anthropic-messages",
        baseUrl: expectedUrl,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        cost: { input: inputCost },
      });
    },
  );

  it.each(["claude-sonnet-5", "claude-opus-5", "not-a-vertex-model"])(
    "does not invent regional inventory for %s",
    async (modelId) => {
      vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
      const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
      expect(
        provider.resolveDynamicModel?.({
          provider: "anthropic-vertex",
          modelId,
          modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    { modelId: "claude-sonnet-4-6", baseUrl: "https://aiplatform.googleapis.com" },
    {
      modelId: "regional-sonnet",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
      params: { canonicalModelId: "claude-sonnet-5" },
    },
  ])("preserves authored $modelId during configured completion", async (authored) => {
    vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
    const registry = ModelRegistry.create(AuthStorage.inMemory(), "/fixture/agent/models.json", {
      includePluginCatalogs: false,
      modelsJsonContents: JSON.stringify({
        providers: {
          "anthropic-vertex": {
            api: "anthropic-messages",
            baseUrl: authored.baseUrl,
            models: [{ id: authored.modelId, params: authored.params }],
          },
        },
      }),
    });
    const model = provider.resolveDynamicModel?.({
      provider: "anthropic-vertex",
      modelId: authored.modelId,
      modelRegistry: registry,
      providerConfig: { baseUrl: "https://aiplatform.eu.rep.googleapis.com" },
    });

    expect(model).toMatchObject({ id: authored.modelId, baseUrl: authored.baseUrl });
    expect(registry.getError()).toBeUndefined();
  });
});
