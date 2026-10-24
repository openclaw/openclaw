import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
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

const facts = (contextWindow: number, supportsTools: boolean, contextTokens = contextWindow) => ({
  contextWindow,
  contextTokens,
  compat: { supportsTools },
});
const absentFacts = /"(?:contextWindow|contextTokens|supportsTools)"/u;

it("persists verified router facts and refreshes unknown fields without replacing explicit values", async () => {
  let loadedModel = "model-a";
  const propsRequests: string[] = [];
  await withServer(
    (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      const send = (body: unknown) => response.end(JSON.stringify(body));
      if (url.pathname === "/health") {
        response.end("{}");
      } else if (url.pathname === "/models") {
        send({
          data: ["model-a", "model-b"].map((id) => ({
            id,
            object: "model",
            status: { value: id === loadedModel ? "loaded" : "unloaded" },
          })),
        });
      } else if (url.pathname === "/props") {
        propsRequests.push(url.search);
        send({
          default_generation_settings: { n_ctx: 32768 },
          chat_template_caps: { supports_tool_calls: true },
        });
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    },
    async (baseUrl) => {
      const configured = {
        baseUrl,
        headers: { Authorization: "Bearer router-fixture" },
        models: [],
      };
      const setup = await prepareLlamaServerSetup({
        config: { models: { providers: { "llama-cpp": configured } } },
        env: {},
        modelRef: "llama-cpp/model-a",
      });
      const saved = setup ? applyProviderAuthConfigPatch({}, setup.configPatch, setup) : undefined;
      const provider = saved?.models?.providers?.["llama-cpp"];
      if (!saved || !provider) {
        throw new Error("Expected a llama-server setup config patch");
      }
      expect(provider.models.find((model) => model.id === "model-a")).toMatchObject(
        facts(32768, true),
      );
      const unloaded = provider.models.find((model) => model.id === "model-b");
      expect(unloaded).toMatchObject({ id: "model-b" });
      expect(JSON.stringify(unloaded)).not.toMatch(absentFacts);

      const refreshModel = async () =>
        (await refresh(saved)).find((model) => model.id === "model-b");
      expect(await refreshModel()).toMatchObject(facts(128000, false));
      loadedModel = "model-b";
      expect(await refreshModel()).toMatchObject(facts(32768, true));

      const savedModels = provider.models;
      for (const route of [
        { baseUrl: `${baseUrl}/other/v1` },
        { api: "openai-responses" as const },
      ]) {
        provider.models = savedModels.map((model) =>
          model.id === "model-b" ? Object.assign({}, model, route) : model,
        );
        const otherRoute = await refreshModel();
        expect(otherRoute).toMatchObject(route);
        expect(JSON.stringify(otherRoute)).not.toMatch(absentFacts);
      }
      provider.models = savedModels;

      provider.models = provider.models.map((model) =>
        model.id === "model-b" ? Object.assign({}, model, facts(24000, false, 16000)) : model,
      );
      expect(await refreshModel()).toMatchObject(facts(24000, false, 16000));
      expect(propsRequests).toEqual(
        ["a", "a", "b", "b", "b", "b"].map((id) => `?model=model-${id}&autoload=false`),
      );
    },
  );
});
