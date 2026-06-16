// ClawRouter provider catalog maps credential-scoped routes to OpenClaw transports.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  getCachedLiveProviderModelRows,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export const CLAWROUTER_DEFAULT_BASE_URL = "https://clawrouter.openclaw.ai";

const PROVIDER_ID = "clawrouter";
const CATALOG_CACHE_TTL_MS = 60_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type CatalogRoute = {
  path: string;
  requestFormat: string;
  methods: string[];
};

type CatalogModel = {
  id: string;
  upstream: string;
  capabilities: string[];
};

type CatalogProvider = {
  id: string;
  displayName: string;
  openaiCompatible: boolean;
  nativeBaseUrl: string;
  routes: CatalogRoute[];
  models: CatalogModel[];
};

type RoutedModel = {
  definition: ModelDefinitionConfig;
  upstreamModel?: string;
};

type CatalogSnapshot = {
  apiBaseUrl: string;
  authorizationHeader: string;
  modelsByRoute: Map<string, ModelDefinitionConfig>;
  nativeModelIds: Map<string, string>;
};

let catalogSnapshot: CatalogSnapshot | undefined;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(readString).filter((entry): entry is string => Boolean(entry))
    : [];
}

function readCatalogRows(body: unknown): readonly unknown[] {
  const providers = readRecord(body)?.providers;
  if (!Array.isArray(providers)) {
    throw new Error("ClawRouter catalog response must contain providers[]");
  }
  return providers;
}

function parseCatalogRoute(value: unknown): CatalogRoute | undefined {
  const row = readRecord(value);
  const path = readString(row?.path);
  const requestFormat = readString(row?.requestFormat);
  if (!path || !requestFormat) {
    return undefined;
  }
  return {
    path,
    requestFormat,
    methods: readStringArray(row?.methods).map((method) => method.toUpperCase()),
  };
}

function parseCatalogModel(value: unknown): CatalogModel | undefined {
  const row = readRecord(value);
  const id = readString(row?.id);
  const upstream = readString(row?.upstream);
  if (!id || !upstream) {
    return undefined;
  }
  return {
    id,
    upstream,
    capabilities: readStringArray(row?.capabilities),
  };
}

function parseCatalogProvider(value: unknown): CatalogProvider | undefined {
  const row = readRecord(value);
  const id = readString(row?.id);
  const nativeBaseUrl = readString(row?.nativeBaseUrl);
  if (!id || !nativeBaseUrl || !nativeBaseUrl.startsWith("/v1/native/")) {
    return undefined;
  }
  return {
    id,
    displayName: readString(row?.displayName) ?? id,
    openaiCompatible: row?.openaiCompatible === true,
    nativeBaseUrl,
    routes: Array.isArray(row?.routes)
      ? row.routes.map(parseCatalogRoute).filter((route): route is CatalogRoute => Boolean(route))
      : [],
    models: Array.isArray(row?.models)
      ? row.models.map(parseCatalogModel).filter((model): model is CatalogModel => Boolean(model))
      : [],
  };
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeClawRouterRootUrl(baseUrl: string | undefined): string {
  const normalized = trimTrailingSlashes(baseUrl?.trim() || CLAWROUTER_DEFAULT_BASE_URL);
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}

export function normalizeClawRouterApiBaseUrl(baseUrl: string | undefined): string {
  return `${normalizeClawRouterRootUrl(baseUrl)}/v1`;
}

function routeKey(baseUrl: string, modelId: string): string {
  return `${trimTrailingSlashes(baseUrl)}\0${modelId}`;
}

function supportsCapability(model: CatalogModel, ...capabilities: string[]): boolean {
  return capabilities.some((capability) => model.capabilities.includes(capability));
}

function findNativeRoute(
  provider: CatalogProvider,
  requestFormat: string,
): CatalogRoute | undefined {
  return provider.routes.find(
    (route) => route.methods.includes("POST") && route.requestFormat === requestFormat,
  );
}

function googleNativeBaseUrl(rootUrl: string, provider: CatalogProvider, route: CatalogRoute) {
  const modelPathIndex = route.path.indexOf("/models/${model}");
  if (modelPathIndex <= 0) {
    return undefined;
  }
  return `${rootUrl}${provider.nativeBaseUrl}${route.path.slice(0, modelPathIndex)}`;
}

function buildRoutedModel(
  rootUrl: string,
  provider: CatalogProvider,
  model: CatalogModel,
): RoutedModel | undefined {
  let api: ModelDefinitionConfig["api"];
  let baseUrl: string;
  let upstreamModel: string | undefined;

  if (provider.openaiCompatible && supportsCapability(model, "llm.responses")) {
    api = "openai-responses";
    baseUrl = `${rootUrl}/v1`;
  } else if (provider.openaiCompatible && supportsCapability(model, "llm.chat")) {
    api = "openai-completions";
    baseUrl = `${rootUrl}/v1`;
  } else if (
    supportsCapability(model, "llm.messages") &&
    findNativeRoute(provider, "anthropic.messages")
  ) {
    api = "anthropic-messages";
    baseUrl = `${rootUrl}${provider.nativeBaseUrl}`;
    upstreamModel = model.upstream;
  } else {
    const googleRoute =
      supportsCapability(model, "llm.generate", "llm.stream") &&
      findNativeRoute(provider, "google.generate_content");
    const googleBaseUrl = googleRoute
      ? googleNativeBaseUrl(rootUrl, provider, googleRoute)
      : undefined;
    if (!googleBaseUrl) {
      return undefined;
    }
    api = "google-generative-ai";
    baseUrl = googleBaseUrl;
    upstreamModel = model.upstream;
  }

  return {
    definition: {
      id: model.id,
      name: `${provider.displayName}: ${model.id}`,
      api,
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: DEFAULT_COST,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    },
    upstreamModel,
  };
}

function updateDiscoveredModels(
  rootUrl: string,
  providers: CatalogProvider[],
  apiKey: string,
): ModelDefinitionConfig[] {
  const models = new Map<string, ModelDefinitionConfig>();
  const modelsByRoute = new Map<string, ModelDefinitionConfig>();
  const nativeModelIds = new Map<string, string>();
  for (const provider of providers) {
    for (const model of provider.models) {
      const routed = buildRoutedModel(rootUrl, provider, model);
      if (!routed || models.has(routed.definition.id)) {
        continue;
      }
      models.set(routed.definition.id, routed.definition);
      const key = routeKey(routed.definition.baseUrl ?? `${rootUrl}/v1`, routed.definition.id);
      modelsByRoute.set(key, routed.definition);
      modelsByRoute.set(routeKey(`${rootUrl}/v1`, routed.definition.id), routed.definition);
      if (routed.upstreamModel) {
        nativeModelIds.set(key, routed.upstreamModel);
      }
    }
  }
  // Discovery owns one active provider config, so replace the whole snapshot.
  // Keeping older credential-scoped catalogs would leak stale grants and grow forever.
  catalogSnapshot = {
    apiBaseUrl: `${rootUrl}/v1`,
    authorizationHeader: `Bearer ${apiKey}`,
    modelsByRoute,
    nativeModelIds,
  };
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function buildClawRouterProviderConfig(params: {
  apiKey: string;
  discoveryApiKey?: string;
  baseUrl?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  const rootUrl = normalizeClawRouterRootUrl(params.baseUrl);
  const rows = await getCachedLiveProviderModelRows({
    providerId: PROVIDER_ID,
    endpoint: `${rootUrl}/v1/catalog`,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    readRows: readCatalogRows,
    ttlMs: CATALOG_CACHE_TTL_MS,
    shouldCacheRows: (providers) => providers.length > 0,
    auditContext: "clawrouter-model-discovery",
  });
  const providers = rows
    .map(parseCatalogProvider)
    .filter((provider): provider is CatalogProvider => Boolean(provider));
  return {
    baseUrl: `${rootUrl}/v1`,
    api: "openai-responses",
    apiKey: params.apiKey,
    authHeader: true,
    models: updateDiscoveredModels(rootUrl, providers, params.apiKey),
  };
}

export function resolveDiscoveredClawRouterModel(params: {
  baseUrl?: string;
  modelId: string;
}): ProviderRuntimeModel | undefined {
  const apiBaseUrl = normalizeClawRouterApiBaseUrl(params.baseUrl);
  if (catalogSnapshot?.apiBaseUrl !== apiBaseUrl) {
    return undefined;
  }
  const model = catalogSnapshot.modelsByRoute.get(routeKey(apiBaseUrl, params.modelId));
  return model ? { ...model, provider: PROVIDER_ID } : undefined;
}

export function normalizeClawRouterResolvedModel(
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  const discovered = catalogSnapshot?.modelsByRoute.get(routeKey(model.baseUrl, model.id));
  if (!catalogSnapshot || !discovered) {
    return undefined;
  }
  const discoveredBaseUrl = discovered.baseUrl ?? catalogSnapshot.apiBaseUrl;
  const upstreamModel = catalogSnapshot.nativeModelIds.get(routeKey(discoveredBaseUrl, model.id));
  return {
    ...model,
    api: discovered.api ?? model.api,
    baseUrl: discoveredBaseUrl,
    headers: {
      ...model.headers,
      Authorization: catalogSnapshot.authorizationHeader,
    },
    ...(upstreamModel && upstreamModel !== model.id ? { id: upstreamModel } : {}),
  };
}

export function clearClawRouterCatalogForTests(): void {
  catalogSnapshot = undefined;
}
