import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  getCachedLiveProviderModelRows,
  loadBundledModelIdentityFactsResolver,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asFiniteNumberInRange,
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterRootUrl } from "./base-url.js";
import { CLAWROUTER_ROUTE_METADATA_KEY as ROUTE_METADATA_KEY } from "./provider-policy-api.js";

const PROVIDER_ID = "clawrouter";
// Inventory changes infrequently; inference still enforces current grants and budgets.
// Explicit catalog refresh bypasses this response cache at the acquisition owner.
const CATALOG_CACHE_TTL_MS = 60 * 60_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const CLAWROUTER_REASONING_EFFORT_LEVELS = [
  ["none", "off"],
  ["minimal", "minimal"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
] as const;
type CatalogReasoningEffort = (typeof CLAWROUTER_REASONING_EFFORT_LEVELS)[number][0];

type CatalogRoute = {
  path: string;
  requestFormat: string;
  methods: string[];
};

type CatalogProvider = {
  id: string;
  displayName: string;
  openaiCompatible: boolean;
  nativeBaseUrl: string;
  routes: CatalogRoute[];
  models: unknown[];
  hostedWebSearchModels: Set<string>;
};

type RouteMetadata = {
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  upstreamModel?: string;
  serviceTiers?: string[];
  hostedWebSearch?: true;
};

export function normalizeClawRouterReasoningEfforts(
  value: unknown,
): CatalogReasoningEffort[] | undefined {
  if (!Array.isArray(value) || value.length > CLAWROUTER_REASONING_EFFORT_LEVELS.length) {
    return undefined;
  }
  const advertised = new Set(value);
  const efforts = CLAWROUTER_REASONING_EFFORT_LEVELS.filter(([effort]) =>
    advertised.has(effort),
  ).map(([effort]) => effort);
  return efforts.length > 0 ? efforts : undefined;
}

function readCatalogRows(body: unknown): readonly unknown[] {
  const providers = asOptionalRecord(body)?.providers;
  if (!Array.isArray(providers)) {
    throw new Error("ClawRouter catalog response must contain providers[]");
  }
  return providers;
}

function parseCatalogRoute(value: unknown): CatalogRoute | undefined {
  const row = asOptionalRecord(value);
  const path = normalizeOptionalString(row?.path);
  const requestFormat = normalizeOptionalString(row?.requestFormat);
  if (!path || !requestFormat) {
    return undefined;
  }
  return {
    path,
    requestFormat,
    methods: normalizeTrimmedStringList(row?.methods).map((method) => method.toUpperCase()),
  };
}

function parseCatalogInput(value: unknown): Array<"text" | "image"> | undefined {
  if (value === undefined) {
    return undefined;
  }
  // A present but unusable declaration must not regain vision through a name heuristic.
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 2 ||
    !value.every((modality) => modality === "text" || modality === "image")
  ) {
    return ["text"];
  }
  return value;
}

function parseCatalogProvider(value: unknown): CatalogProvider | undefined {
  const row = asOptionalRecord(value);
  const id = normalizeOptionalString(row?.id);
  const nativeBaseUrl = normalizeOptionalString(row?.nativeBaseUrl);
  if (!id || !nativeBaseUrl || !nativeBaseUrl.startsWith("/v1/native/")) {
    return undefined;
  }
  return {
    id,
    displayName: normalizeOptionalString(row?.displayName) ?? id,
    openaiCompatible: row?.openaiCompatible === true,
    nativeBaseUrl,
    routes: Array.isArray(row?.routes)
      ? row.routes.map(parseCatalogRoute).filter((route): route is CatalogRoute => Boolean(route))
      : [],
    models: Array.isArray(row?.models) ? row.models : [],
    hostedWebSearchModels: new Set(
      (Array.isArray(row?.offers) ? row.offers : []).flatMap((offerValue) => {
        const offer = asOptionalRecord(offerValue);
        const admission = asOptionalRecord(offer?.hostedToolAdmission);
        return offer?.endpoint === "responses" &&
          offer.transport === "http" &&
          offer.routeKind === "unified" &&
          offer.route === "/v1/responses" &&
          offer.eligible === true &&
          typeof offer.modelId === "string" &&
          admission?.version === "clawrouter.hosted-tool-admission.v1" &&
          admission.web_search === "admitted"
          ? [offer.modelId]
          : [];
      }),
    ),
  };
}

// Older router catalogs omit input. Match exact native OpenAI identities, not a
// GPT generation prefix: unknown siblings can have different modality contracts.
const OPENAI_NATIVE_IMAGE_MODEL_IDS = new Set([
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
]);

type ResolveNativeModelFacts = Awaited<ReturnType<typeof loadBundledModelIdentityFactsResolver>>;

// Upstream catalogs whose first-party model facts are qualified for routed rows. A row
// inherits only when its upstream id and wire API match the bundled native row exactly.
const NATIVE_MODEL_FACT_PROVIDERS = new Set(["openai", "anthropic"]);
// Catalog providers whose id differs from the bundled provider serving the same native API.
const BUNDLED_CATALOG_PROVIDER_IDS = new Map([["google-gemini", "google"]]);

function microsPerMillionToCost(value: number | undefined): number {
  return value === undefined ? 0 : value / 1_000_000;
}

function buildRoutedModel(
  rootUrl: string,
  provider: CatalogProvider,
  value: unknown,
  resolveNativeModelFacts: ResolveNativeModelFacts,
): ModelDefinitionConfig | undefined {
  const row = asOptionalRecord(value);
  const id = normalizeOptionalString(row?.id);
  const upstream = normalizeOptionalString(row?.upstream);
  if (!id || !upstream) {
    return undefined;
  }
  const capabilities = normalizeTrimmedStringList(row?.capabilities);
  const supportedReasoningEfforts = normalizeClawRouterReasoningEfforts(
    row?.supportedReasoningEfforts,
  );
  const pricing = asOptionalRecord(row?.pricing);
  const native = asOptionalRecord(row?.nativeCapabilities);
  const responses = asOptionalRecord(asOptionalRecord(native?.endpoints)?.responses);
  const supportsHostedWebSearch =
    native?.version === "clawrouter.native-capabilities.v1" &&
    Array.isArray(responses?.hostedTools) &&
    responses.hostedTools.every((tool) => typeof tool === "string") &&
    responses.hostedTools.includes("web_search");
  let api: NonNullable<ModelDefinitionConfig["api"]>;
  let baseUrl: string;
  let upstreamModel: string | undefined;

  if (provider.openaiCompatible && capabilities.includes("llm.responses")) {
    api = "openai-responses";
    baseUrl = `${rootUrl}/v1`;
  } else if (provider.openaiCompatible && capabilities.includes("llm.chat")) {
    api = "openai-completions";
    baseUrl = `${rootUrl}/v1`;
  } else if (
    capabilities.includes("llm.messages") &&
    provider.routes.some(
      (route) => route.methods.includes("POST") && route.requestFormat === "anthropic.messages",
    )
  ) {
    api = "anthropic-messages";
    baseUrl = `${rootUrl}${provider.nativeBaseUrl}`;
    upstreamModel = upstream;
  } else {
    const googleRoute =
      capabilities.includes("llm.stream") &&
      provider.routes.find(
        (route) =>
          route.methods.includes("POST") &&
          route.requestFormat === "google.generate_content" &&
          route.path.includes(":streamGenerateContent"),
      );
    const modelPathIndex = googleRoute ? googleRoute.path.indexOf("/models/${model}") : -1;
    if (!googleRoute || modelPathIndex <= 0) {
      return undefined;
    }
    api = "google-generative-ai";
    baseUrl = `${rootUrl}${provider.nativeBaseUrl}${googleRoute.path.slice(0, modelPathIndex)}`;
    upstreamModel = upstream;
  }

  const providerPrefix = `${provider.id}/`;
  const modelLabel = id.startsWith(providerPrefix) ? id.slice(providerPrefix.length) : id;
  const qualifiedId = `${provider.id}/${id}`.toLowerCase();
  let thinkingLevelMap: ModelDefinitionConfig["thinkingLevelMap"];
  if (supportedReasoningEfforts) {
    thinkingLevelMap = {};
    const supported = new Set(supportedReasoningEfforts);
    for (const [effort, level] of CLAWROUTER_REASONING_EFFORT_LEVELS) {
      thinkingLevelMap[level] = supported.has(effort) ? effort : null;
    }
  }
  const serviceTiers = Array.isArray(pricing?.serviceTiers)
    ? normalizeTrimmedStringList(pricing.serviceTiers.map((tier) => asOptionalRecord(tier)?.id))
    : undefined;
  // Identity facts match only an exact bundled row with the same upstream id and wire API.
  const identityFacts = resolveNativeModelFacts({
    provider: BUNDLED_CATALOG_PROVIDER_IDS.get(provider.id) ?? provider.id,
    api,
    modelId: upstream,
  });
  const nativeFacts = NATIVE_MODEL_FACT_PROVIDERS.has(provider.id) ? identityFacts : undefined;
  // Service catalog facts win over inherited native defaults.
  const compat = {
    ...nativeFacts?.compat,
    ...(supportedReasoningEfforts
      ? { supportsReasoningEffort: true, supportedReasoningEfforts }
      : {}),
  };

  return {
    id,
    name: normalizeOptionalString(row?.displayName) ?? `${provider.displayName} · ${modelLabel}`,
    api,
    baseUrl,
    reasoning:
      supportedReasoningEfforts !== undefined ||
      /(?:claude-|gemini-|gpt-5|gpt-oss|deepseek-v|reasoner|glm-5|grok-4|minimax-m)/u.test(
        qualifiedId,
      ),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
    ...(nativeFacts?.mediaInput ? { mediaInput: nativeFacts.mediaInput } : {}),
    // A family comes from the bundled catalog's declaration, never from this row's id.
    ...(identityFacts?.family ? { family: identityFacts.family } : {}),
    input:
      parseCatalogInput(row?.input) ??
      ((provider.id === "openai" && OPENAI_NATIVE_IMAGE_MODEL_IDS.has(upstream)) ||
      /(?:claude-|gemini-|gpt-4o|gpt-5)/u.test(qualifiedId)
        ? ["text", "image"]
        : ["text"]),
    cost: pricing
      ? {
          input: microsPerMillionToCost(
            asFiniteNumberInRange(pricing.inputMicrosPerMillion, { min: 0 }),
          ),
          output: microsPerMillionToCost(
            asFiniteNumberInRange(pricing.outputMicrosPerMillion, { min: 0 }),
          ),
          cacheRead: microsPerMillionToCost(
            asFiniteNumberInRange(pricing.cachedInputMicrosPerMillion, { min: 0 }),
          ),
          cacheWrite: microsPerMillionToCost(
            asFiniteNumberInRange(pricing.cacheWrite5mInputMicrosPerMillion, { min: 0 }) ??
              asFiniteNumberInRange(pricing.cacheWrite1hInputMicrosPerMillion, { min: 0 }),
          ),
        }
      : DEFAULT_COST,
    contextWindow: asPositiveSafeInteger(pricing?.maxInputTokens) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: asPositiveSafeInteger(pricing?.defaultMaxOutputTokens) ?? DEFAULT_MAX_TOKENS,
    params: {
      [ROUTE_METADATA_KEY]: {
        api,
        baseUrl,
        ...(upstreamModel ? { upstreamModel } : {}),
        // Support is not a grant: require this key's exact matching route admission.
        ...(provider.id === "openai" &&
        api === "openai-responses" &&
        supportsHostedWebSearch &&
        provider.hostedWebSearchModels.has(id)
          ? { hostedWebSearch: true }
          : {}),
        // Only this catalog provider/transport owns OpenAI scheduling tiers.
        ...(provider.id === "openai" && api === "openai-responses" && serviceTiers?.length
          ? { serviceTiers }
          : {}),
      } satisfies RouteMetadata,
    },
  };
}

function buildDiscoveredModels(
  rootUrl: string,
  providers: CatalogProvider[],
  resolveNativeModelFacts: ResolveNativeModelFacts,
): ModelDefinitionConfig[] {
  const models = new Map<string, ModelDefinitionConfig>();
  for (const provider of providers) {
    for (const model of provider.models) {
      const routed = buildRoutedModel(rootUrl, provider, model, resolveNativeModelFacts);
      if (!routed || models.has(routed.id)) {
        continue;
      }
      models.set(routed.id, routed);
    }
  }
  return [...models.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

export async function buildClawRouterProviderConfig(params: {
  apiKey: string;
  discoveryApiKey?: string;
  baseUrl?: string;
}): Promise<ModelProviderConfig & { api: "openai-responses"; baseUrl: string }> {
  const rootUrl = normalizeClawRouterRootUrl(params.baseUrl);
  const rows = await getCachedLiveProviderModelRows({
    providerId: PROVIDER_ID,
    endpoint: `${rootUrl}/v1/catalog`,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    readRows: readCatalogRows,
    ttlMs: CATALOG_CACHE_TTL_MS,
    auditContext: "clawrouter-model-discovery",
  });
  const providers = rows
    .map(parseCatalogProvider)
    .filter((provider): provider is CatalogProvider => Boolean(provider));
  return {
    baseUrl: `${rootUrl}/v1`,
    api: "openai-responses",
    apiKey: params.apiKey,
    models: buildDiscoveredModels(
      rootUrl,
      providers,
      await loadBundledModelIdentityFactsResolver(),
    ),
  };
}

function readRouteMetadata(params: ProviderRuntimeModel["params"]): RouteMetadata | undefined {
  const row = asOptionalRecord(params?.[ROUTE_METADATA_KEY]);
  const baseUrl = normalizeOptionalString(row?.baseUrl);
  const api = normalizeOptionalString(row?.api);
  if (
    !baseUrl ||
    (api !== "openai-responses" &&
      api !== "openai-completions" &&
      api !== "anthropic-messages" &&
      api !== "google-generative-ai")
  ) {
    return undefined;
  }
  const upstreamModel = normalizeOptionalString(row?.upstreamModel);
  return {
    api,
    baseUrl,
    ...(upstreamModel ? { upstreamModel } : {}),
  };
}

function stripRouteMetadata(
  params: ProviderRuntimeModel["params"],
): ProviderRuntimeModel["params"] {
  if (!params || !(ROUTE_METADATA_KEY in params)) {
    return params;
  }
  const { [ROUTE_METADATA_KEY]: _routeMetadata, ...remaining } = params;
  return Object.keys(remaining).length > 0 ? remaining : undefined;
}

export function normalizeClawRouterResolvedModel(
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  const route = readRouteMetadata(model.params);
  if (!route) {
    return undefined;
  }
  return {
    ...model,
    api: route.api,
    baseUrl: route.baseUrl,
  };
}

export function prepareClawRouterRequestModel(model: ProviderRuntimeModel): ProviderRuntimeModel {
  const route = readRouteMetadata(model.params);
  if (!route) {
    return model;
  }
  return {
    ...model,
    params: stripRouteMetadata(model.params),
    ...(route.upstreamModel && route.upstreamModel !== model.id ? { id: route.upstreamModel } : {}),
  };
}
