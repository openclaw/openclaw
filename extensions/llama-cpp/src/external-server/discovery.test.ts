import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import llamaCppProviderDiscovery from "../../provider-discovery.js";
import { discoverLlamaServer } from "./discovery.js";
import { prepareLlamaServerSetup } from "./setup.js";

function withDiscovery(
  reply: (request: IncomingMessage, response: ServerResponse) => unknown,
  run: (baseUrl: string) => Promise<void>,
) {
  return withServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const body = reply(request, response);
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  }, run);
}

const result = (id: string) => ({ kind: "success", models: [{ config: { id } }] });

it.each([
  ["<!doctype html><html></html>", true],
  [JSON.stringify({ app: "local-models" }), false],
  [undefined, undefined],
])("discovers rows behind %s with reasoning=%s", async (body, capability) => {
  const requests: string[] = [];
  await withDiscovery(
    ({ url }) => {
      requests.push(url ?? "");
      if (url === "/models" && body) {
        return body;
      }
      if (url?.endsWith("/models")) {
        return {
          data: [{ id: "qwen/model:Q4_K_M", object: "model", status: { value: "sleeping" } }],
        };
      }
      return url?.startsWith("/props")
        ? {
            chat_template_caps: {
              supports_reasoning_effort: capability,
              supports_tool_calls: true,
            },
          }
        : {};
    },
    async (baseUrl) => {
      await expect(discoverLlamaServer({ baseUrl: `${baseUrl}/v1` })).resolves.toMatchObject({
        kind: "success",
        endpoint: { origin: baseUrl, inferenceBaseUrl: `${baseUrl}/v1` },
        models: [
          {
            status: "sleeping",
            config: {
              id: "qwen/model:Q4_K_M",
              reasoning: capability === true,
              compat: { supportsReasoningEffort: capability === true },
            },
          },
        ],
      });
      expect(requests).toEqual([
        "/health",
        "/models",
        ...(body ? ["/v1/models"] : []),
        "/props?model=qwen%2Fmodel%3AQ4_K_M&autoload=false",
      ]);
    },
  );
});

it("attaches the normalized endpoint to shared discovery failures", async () => {
  await withDiscovery(
    () => ({}),
    async (baseUrl) => {
      await expect(discoverLlamaServer({ baseUrl: `${baseUrl}/v1` })).resolves.toMatchObject({
        kind: "invalid-response",
        path: "/v1/models",
        endpoint: { origin: baseUrl, inferenceBaseUrl: `${baseUrl}/v1` },
      });
    },
  );
});

it.each([
  { name: "API key", access: { apiKey: "endpoint-key" } },
  { name: "authorization header", access: { headers: { Authorization: "Bearer endpoint-key" } } },
])("fetches fresh discovery for $name and subsequent anonymous requests", async ({ access }) => {
  let modelId = "initial";
  const modelRequests: Array<string | undefined> = [];
  await withDiscovery(
    (request) => {
      if (request.url === "/models") {
        modelRequests.push(request.headers.authorization);
        return { data: [{ id: modelId, status: { value: "unloaded" } }] };
      }
      return {};
    },
    async (baseUrl) => {
      await expect(discoverLlamaServer({ baseUrl })).resolves.toMatchObject(result("initial"));
      modelId = "fresh";
      await expect(discoverLlamaServer({ baseUrl, ...access })).resolves.toMatchObject(
        result("fresh"),
      );
      await expect(discoverLlamaServer({ baseUrl })).resolves.toMatchObject(result("fresh"));
      expect(modelRequests).toEqual([undefined, "Bearer endpoint-key", undefined]);
    },
  );
});

async function refresh(config: ProviderCatalogContext["config"]) {
  const catalog = await llamaCppProviderDiscovery.catalog.run({
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  });
  if (!catalog || !("provider" in catalog)) {
    throw new Error("Expected a successful llama-server catalog refresh");
  }
  return catalog.provider.models;
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
  await withDiscovery(
    (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        return {};
      }
      if (url.pathname === "/models") {
        return {
          data: ["model-a", "model-b"].map((id) => ({
            id,
            status: { value: id === loadedModel ? "loaded" : "unloaded" },
          })),
        };
      }
      if (url.pathname === "/props") {
        propsRequests.push(url.search);
        return {
          default_generation_settings: { n_ctx: 32768 },
          chat_template_caps: { supports_tool_calls: true },
        };
      }
      response.statusCode = 404;
      return {};
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
      provider.models = savedModels.map((model) =>
        model.id === "model-b" ? Object.assign({}, model, facts(24000, false, 16000)) : model,
      );
      expect(await refreshModel()).toMatchObject(facts(24000, false, 16000));
      expect(propsRequests).toEqual(
        ["a", "a", "b", "b", "b", "b"].map((id) => `?model=model-${id}&autoload=false`),
      );
    },
  );
});
