import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicVertexPlugin from "./index.js";

const globalUrl = "https://aiplatform.googleapis.com";
const aliasParams = { canonicalModelId: "claude-sonnet-5" };
async function resolveModel(
  modelId: string,
  baseUrl?: string,
  modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory()),
) {
  const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
  return provider.resolveDynamicModel?.({
    provider: "anthropic-vertex",
    modelId,
    modelRegistry,
    providerConfig: { baseUrl },
  });
}

describe("Anthropic Vertex registered runtime model resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["us-central1", "claude-sonnet-4-6", "", "https://us-central1-aiplatform.googleapis.com", 3],
    ["eu", "claude-sonnet-5", undefined, "https://aiplatform.eu.rep.googleapis.com", 2.2],
    ["us-central1", "claude-sonnet-5", globalUrl, globalUrl, 2],
  ] as const)(
    "resolves missing model in %s: %s, %s",
    async (region, modelId, baseUrl, expectedUrl, inputCost) => {
      vi.stubEnv("GOOGLE_CLOUD_LOCATION", region);
      const model = await resolveModel(modelId, baseUrl);
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
      expect(await resolveModel(modelId)).toBeUndefined();
    },
  );

  it.each([
    ["claude-sonnet-4-6", globalUrl, undefined],
    ["regional-sonnet", "https://us-east5-aiplatform.googleapis.com", aliasParams],
  ] as const)(
    "preserves authored %s during configured completion",
    async (modelId, baseUrl, params) => {
      vi.stubEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
      const authored = { api: "anthropic-messages", baseUrl, models: [{ id: modelId, params }] };
      const registry = ModelRegistry.create(AuthStorage.inMemory(), "/fixture/agent/models.json", {
        includePluginCatalogs: false,
        modelsJsonContents: JSON.stringify({ providers: { "anthropic-vertex": authored } }),
      });
      const model = await resolveModel(
        modelId,
        "https://aiplatform.eu.rep.googleapis.com",
        registry,
      );
      expect(model).toMatchObject({ id: modelId, baseUrl });
      expect(registry.getError()).toBeUndefined();
    },
  );
});
