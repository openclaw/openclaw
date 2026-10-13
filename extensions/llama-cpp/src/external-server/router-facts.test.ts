import type {
  ProviderAppGuidedSetupContext,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import llamaCppProviderDiscovery from "../../provider-discovery.js";
import { prepareLlamaServerSetup } from "./setup.js";

async function refresh(config: ProviderCatalogContext["config"]) {
  const context: ProviderCatalogContext = {
    config,
    env: {},
    resolveProviderApiKey: () => ({
      apiKey: llamaCppProviderDiscovery.resolveSyntheticAuth({
        config,
        provider: "llama-cpp",
        providerConfig: config.models?.providers?.["llama-cpp"],
      })?.apiKey,
    }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  };
  const result = await llamaCppProviderDiscovery.catalog.run(context);
  if (!result || !("provider" in result)) {
    throw new Error("Expected a successful llama-server catalog refresh");
  }
  return result.provider.models;
}

it("persists verified router facts and refreshes unknown fields without replacing explicit values", async () => {
  let loadedModel = "model-a";
  const propsRequests: string[] = [];
  await withServer(
    (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/health") {
        response.end("{}");
      } else if (url.pathname === "/models") {
        response.end(
          JSON.stringify({
            data: ["model-a", "model-b"].map((id) => ({
              id,
              object: "model",
              status: { value: id === loadedModel ? "loaded" : "unloaded" },
            })),
          }),
        );
      } else if (url.pathname === "/props") {
        propsRequests.push(url.search);
        response.end(
          JSON.stringify({
            default_generation_settings: { n_ctx: 32768 },
            chat_template_caps: { supports_tool_calls: true },
          }),
        );
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    },
    async (baseUrl) => {
      const context: ProviderAppGuidedSetupContext = {
        config: {
          models: {
            providers: {
              "llama-cpp": {
                baseUrl,
                headers: { Authorization: "Bearer router-fixture" },
                models: [],
              },
            },
          },
        },
        env: {},
      };
      const setup = await prepareLlamaServerSetup({
        ...context,
        modelRef: "llama-cpp/model-a",
      });
      const saved = setup?.configPatch;
      const provider = saved?.models?.providers?.["llama-cpp"];
      if (!saved || !provider) {
        throw new Error("Expected a llama-server setup config patch");
      }
      expect(provider.models.find((model) => model.id === "model-a")).toMatchObject({
        contextWindow: 32768,
        contextTokens: 32768,
        compat: { supportsTools: true },
      });
      const unloaded = provider.models.find((model) => model.id === "model-b");
      expect(unloaded).toMatchObject({ id: "model-b" });
      expect(JSON.stringify(unloaded)).not.toMatch(
        /"(?:contextWindow|contextTokens|supportsTools)"/u,
      );

      expect((await refresh(saved)).find((model) => model.id === "model-b")).toMatchObject({
        contextWindow: 128000,
        contextTokens: 128000,
        compat: { supportsTools: false },
      });
      loadedModel = "model-b";
      expect((await refresh(saved)).find((model) => model.id === "model-b")).toMatchObject({
        contextWindow: 32768,
        contextTokens: 32768,
        compat: { supportsTools: true },
      });

      const savedModels = provider.models;
      for (const route of [
        { baseUrl: `${baseUrl}/other/v1` },
        { api: "openai-responses" as const },
      ]) {
        provider.models = savedModels.map((model) =>
          model.id === "model-b" ? Object.assign({}, model, route) : model,
        );
        const otherRoute = (await refresh(saved)).find((model) => model.id === "model-b");
        expect(otherRoute).toMatchObject(route);
        expect(JSON.stringify(otherRoute)).not.toMatch(
          /"(?:contextWindow|contextTokens|supportsTools)"/u,
        );
      }
      provider.models = savedModels;

      provider.models = provider.models.map((model) =>
        model.id === "model-b"
          ? Object.assign({}, model, {
              contextWindow: 24000,
              contextTokens: 16000,
              compat: { supportsTools: false },
            })
          : model,
      );
      expect((await refresh(saved)).find((model) => model.id === "model-b")).toMatchObject({
        contextWindow: 24000,
        contextTokens: 16000,
        compat: { supportsTools: false },
      });
      expect(propsRequests).toEqual([
        "?model=model-a&autoload=false",
        "?model=model-a&autoload=false",
        "?model=model-b&autoload=false",
        "?model=model-b&autoload=false",
        "?model=model-b&autoload=false",
        "?model=model-b&autoload=false",
      ]);
    },
  );
});
