import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { SYNTHETIC_BASE_URL } from "./models.js";
import { buildSyntheticProvider } from "./provider-catalog.js";

const fetchGuard = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

const endpoint = "https://api.synthetic.new/openai/v1/models";
const provider = await registerSingleProviderPlugin(plugin);
const liveModel = {
  id: "hf:Qwen/Qwen3.8-27B",
  name: "Qwen/Qwen3.8-27B",
  input_modalities: ["text", "image"],
  output_modalities: ["text"],
  context_length: 262144,
  max_output_length: 65536,
  supported_features: ["tools", "reasoning"],
  reasoning_parameters: { efforts: ["low", "medium", "xhigh"] },
  pricing: {
    prompt: "$0.00000045",
    completion: "$0.0000022",
    input_cache_reads: "$0.00000009",
    input_cache_writes: "0",
  },
};

function context(baseUrl?: string): ProviderCatalogContext {
  const auth = { apiKey: "SYNTHETIC_API_KEY", discoveryApiKey: "fixture-discovery-key" };
  return {
    config: baseUrl ? { models: { providers: { synthetic: { baseUrl, models: [] } } } } : {},
    env: {},
    resolveProviderApiKey: () => auth,
    resolveProviderAuth: () => ({ ...auth, mode: "api_key", source: "profile" }),
  };
}

const respond = (data: unknown[]) =>
  fetchGuard.mockResolvedValueOnce({
    response: Response.json({ data }),
    finalUrl: endpoint,
    release: vi.fn(),
  });

afterEach(() => {
  fetchGuard.mockReset();
  clearLiveCatalogCacheForTests();
});

it("discovers new models and refreshes known metadata without changing the inference transport", async () => {
  respond([
    liveModel,
    { ...liveModel, id: "hf:zai-org/GLM-5.2", input_modalities: ["text"] },
    {
      ...liveModel,
      id: "syn:small:vision",
      max_output_length: undefined,
      supported_features: undefined,
      reasoning_parameters: { efforts: ["none"] },
    },
    liveModel,
    { ...liveModel, id: "embedding-model", output_modalities: ["embedding"] },
    { ...liveModel, id: "invalid-limits", context_length: -1 },
    { ...liveModel, id: "retired-model", deprecated: true },
  ]);
  const result = await provider.catalog?.run(context());
  expect(result).toMatchObject({
    provider: {
      api: "anthropic-messages",
      baseUrl: SYNTHETIC_BASE_URL,
      apiKey: "SYNTHETIC_API_KEY",
      models: [
        {
          id: liveModel.id,
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 262144,
          maxTokens: 65536,
          cost: { input: 0.45, output: 2.2, cacheRead: 0.09, cacheWrite: 0 },
          compat: { supportsTools: true },
        },
        { id: "hf:zai-org/GLM-5.2", input: ["text"], contextWindow: 262144, maxTokens: 65536 },
        { id: "syn:small:vision", reasoning: false, input: ["text", "image"], maxTokens: 8192 },
      ],
    },
  });
  const request = fetchGuard.mock.calls[0]?.[0];
  const headers = new Headers(request.init.headers);
  expect(request.url).toBe(endpoint);
  expect(headers.get("authorization")).toBe("Bearer fixture-discovery-key");
});

it.each(["failure", "unusable"])("does not substitute seeds for %s discovery", async (mode) => {
  if (mode === "failure") {
    fetchGuard.mockRejectedValueOnce(new Error("fixture unavailable"));
  } else {
    respond([{ id: "missing-metadata" }]);
  }
  const modelIdCatalog = { baseUrl: SYNTHETIC_BASE_URL, modelIds: ["missing-metadata"] };
  await expect(provider.catalog?.run(context())).resolves.toEqual(
    mode === "failure"
      ? { providers: {}, outcomes: [{ provider: "synthetic", status: "unavailable" }] }
      : {
          provider: { ...buildSyntheticProvider(), apiKey: "SYNTHETIC_API_KEY", models: [] },
          outcomes: [{ provider: "synthetic", status: "ready", modelIdCatalog }],
        },
  );
});

it("does not send a custom proxy credential to Synthetic's fixed model endpoint", async () => {
  const result = await provider.catalog?.run(context("https://proxy.example/anthropic"));
  const expected = { baseUrl: "https://proxy.example/anthropic", api: "anthropic-messages" };
  expect(result).toMatchObject({ provider: expected });
  expect(fetchGuard).not.toHaveBeenCalled();
});

it("keeps static discovery network-free and live discovery credential-gated", async () => {
  const staticResult = await provider.staticCatalog?.run(context());
  expect(staticResult).toEqual({ provider: buildSyntheticProvider() });
  const anonymous = { ...context(), resolveProviderApiKey: () => ({ apiKey: undefined }) };
  await expect(provider.catalog?.run(anonymous)).resolves.toBeNull();
  expect(fetchGuard).not.toHaveBeenCalled();
});
