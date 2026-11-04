import {
  CATALOG_DISCOVERY_CONTRACTS,
  type CatalogDiscoveryProvider,
} from "./catalog-discovery-contracts.js";

export const DISCOVERY_BASE = "https://clawrouter.example";
export const DISCOVERY_ID = "Fixture/Alias";
export const DISCOVERY_PROVIDERS = Object.keys(CATALOG_DISCOVERY_CONTRACTS).filter(
  (id): id is CatalogDiscoveryProvider => id in CATALOG_DISCOVERY_CONTRACTS,
);

export function discoveryPayload(provider: CatalogDiscoveryProvider, empty = false) {
  const common = { id: DISCOVERY_ID, object: "model" };
  const rows: Record<CatalogDiscoveryProvider, Record<string, unknown>> = {
    cerebras: {
      id: DISCOVERY_ID,
      name: "Fixture",
      contextWindow: 4096,
      maxOutputTokens: 512,
      pricing: { currency: "USD", inputPerToken: "0", outputPerToken: "0.000001" },
    },
    nvidia: {
      id: DISCOVERY_ID,
      name: "Fixture",
      contextWindow: 4096,
      outputTokenBudget: 8192,
      metadataSource: "featured",
      input: null,
      reasoning: null,
      pricing: null,
    },
    chutes: { ...common, pricing: { prompt: 0, completion: 2 }, confidential_compute: false },
    venice: { ...common, type: "text", model_spec: { pricing: { input: { usd: 0, diem: 2 } } } },
    baseten: { id: DISCOVERY_ID, pricing: { prompt: "0" } },
    arcee: {
      id: DISCOVERY_ID,
      name: "Fixture",
      context_length: 4096,
      max_output_length: 512,
      input_modalities: ["text"],
      output_modalities: ["text"],
      pricing: { prompt: "0" },
    },
    novita: { ...common, created: 1, context_size: 4096, input_token_price_per_m: 0 },
    featherless: { id: DISCOVERY_ID, pricing: { prompt: "0" }, available_on_current_plan: true },
    deepinfra: common,
    bifrost: common,
    litellm: common,
    requesty: { id: DISCOVERY_ID, api: "chat", input_price: "0", supports_vision: false },
  };
  const data = empty ? [] : [rows[provider]];
  if (["cerebras", "nvidia", "featherless"].includes(provider)) {
    return { providerId: provider, catalog: data };
  }
  if (provider === "venice") {
    return { object: "list", type: "text", data };
  }
  return provider === "requesty" || provider === "novita" ? { data } : { object: "list", data };
}

export function discoveryCatalog(
  provider: CatalogDiscoveryProvider,
  routeKind: "native" | "manifest" = "manifest",
) {
  const contract = CATALOG_DISCOVERY_CONTRACTS[provider];
  const path = provider === "requesty" ? "/models/managed" : "/models";
  const route =
    routeKind === "native"
      ? `/v1/native/${provider}${path}`
      : `/v1/proxy/${provider}/${contract.endpoint}`;
  return {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: provider,
        displayName: provider,
        allowed: true,
        executable: true,
        openaiCompatible: true,
        nativeBaseUrl: `/v1/native/${provider}`,
        routes: [
          {
            endpoint: contract.endpoint,
            path,
            methods: ["GET"],
            requestFormat: contract.format,
            responseFormat: contract.format,
          },
          {
            endpoint: "chat_completions",
            path: "/chat/completions",
            methods: ["POST"],
            requestFormat: "openai.chat_completions",
            responseFormat: "openai.chat_completions",
          },
        ],
        offers: [
          {
            endpoint: contract.endpoint,
            routeKind,
            route,
            modelId: null,
            eligible: true,
            transport: "http",
            affordability: "exact-covered",
          },
        ],
        models: [
          { id: `${provider}/static-seed`, upstream: "static-seed", capabilities: ["llm.chat"] },
        ],
      },
    ],
  };
}
