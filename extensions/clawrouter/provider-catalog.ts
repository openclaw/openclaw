import { ModelInferenceCapabilitiesSchema } from "openclaw/plugin-sdk/decisions";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  getCachedLiveProviderModelRows,
  loadBundledModelIdentityFactsResolver,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  MISTRAL_MODEL_TRANSPORT_PATCH,
  XAI_TOOL_MODEL_COMPAT,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asFiniteNumberInRange,
  asOptionalRecord,
  asPositiveSafeInteger,
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeClawRouterRootUrl } from "./base-url.js";
import {
  readClawRouterCapabilityOffers,
  type ClawRouterCapabilityOffer,
} from "./capability-offers.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { CLAWROUTER_ROUTE_METADATA_KEY as ROUTE_METADATA_KEY } from "./provider-policy-api.js";

export const decisionCapabilities = ModelInferenceCapabilitiesSchema.parse(
  manifest.modelCatalog.providers.clawrouter.models.find(
    (model) => model.id === "openai/gpt-6-luna",
  )?.inference,
);

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
  endpoint?: string;
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
  httpOffers: ClawRouterCapabilityOffer[];
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

function readCatalogRows(body: unknown, baseUrl: string): readonly unknown[] {
  const catalog = asOptionalRecord(body);
  const providers = catalog?.providers;
  if (!Array.isArray(providers)) {
    throw new Error("ClawRouter catalog response must contain providers[]");
  }
  const offers =
    catalog?.version === "clawrouter.client-catalog.v1"
      ? readClawRouterCapabilityOffers(body, baseUrl)
      : [];
  return providers.map((provider) => ({
    provider,
    httpOffers: offers.filter((offer) => offer.providerId === asOptionalRecord(provider)?.id),
  }));
}

function parseCatalogRoute(value: unknown): CatalogRoute | undefined {
  const row = asOptionalRecord(value);
  const path = normalizeOptionalString(row?.path);
  const requestFormat = normalizeOptionalString(row?.requestFormat);
  if (!path || !requestFormat) {
    return undefined;
  }
  return {
    endpoint: normalizeOptionalString(row?.endpoint),
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
    value.length > 5 ||
    !value.every((modality) => ["text", "image", "audio", "video", "json"].includes(modality))
  ) {
    return ["text"];
  }
  const input = value.filter(
    (modality): modality is "text" | "image" => modality === "text" || modality === "image",
  );
  return input.length > 0 ? input : ["text"];
}

function parseCatalogProvider(value: unknown): CatalogProvider | undefined {
  // SAFETY: readCatalogRows constructs every cached row with its parsed HTTP-offer array.
  const envelope = value as { provider: unknown; httpOffers: ClawRouterCapabilityOffer[] };
  const row = asOptionalRecord(envelope.provider);
  const id = normalizeOptionalString(row?.id);
  const nativeBaseUrl = normalizeOptionalString(row?.nativeBaseUrl);
  const isFusion = id === "clawrouter" && nativeBaseUrl === "/v1" && row?.openaiCompatible === true;
  if (!id || !nativeBaseUrl || (!nativeBaseUrl.startsWith("/v1/native/") && !isFusion)) {
    return undefined;
  }
  const models = Array.isArray(row?.models) ? row.models : [];
  // Fusion has no native proxy. Only its credential-scoped unified offer is executable.
  const fusionGranted =
    isFusion &&
    row?.allowed === true &&
    row.executable === true &&
    Array.isArray(row.offers) &&
    row.offers.some((offerValue) => {
      const offer = asOptionalRecord(offerValue);
      return (
        offer?.modelId === "clawrouter/fusion" &&
        offer.endpoint === "chat_completions" &&
        offer.transport === "http" &&
        offer.routeKind === "unified" &&
        offer.route === "/v1/chat/completions" &&
        offer.eligible === true
      );
    });
  return {
    id,
    displayName: normalizeOptionalString(row?.displayName) ?? id,
    openaiCompatible: row?.openaiCompatible === true,
    nativeBaseUrl,
    httpOffers: envelope.httpOffers,
    routes: Array.isArray(row?.routes)
      ? row.routes.map(parseCatalogRoute).filter((route): route is CatalogRoute => Boolean(route))
      : [],
    models: isFusion
      ? models.filter((modelValue) => {
          const model = asOptionalRecord(modelValue);
          return (
            fusionGranted &&
            model?.id === "clawrouter/fusion" &&
            model.upstream === "clawrouter/fusion" &&
            Array.isArray(model.capabilities) &&
            model.capabilities.length === 1 &&
            model.capabilities[0] === "llm.chat"
          );
        })
      : models,
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
const NATIVE_MODEL_FACT_PROVIDERS = new Set(["openai", "anthropic", "cohere"]);
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
  let endpoint: string | undefined;

  if (
    provider.id === "xai" &&
    capabilities.includes("llm.responses") &&
    !provider.httpOffers.some(
      (offer) =>
        offer.routeKind === "unified" &&
        offer.model?.id === id &&
        offer.requestFormat === "openai.responses" &&
        offer.responseFormat === "openai.responses" &&
        offer.methods.includes("POST"),
    )
  ) {
    return undefined;
  }

  const cohereChat =
    provider.id === "cohere" && capabilities.includes("llm.chat")
      ? provider.httpOffers.find(
          (offer) =>
            offer.routeKind === "native" &&
            offer.model?.id === id &&
            offer.requestFormat === "openai.chat_completions" &&
            offer.responseFormat === "openai.chat_completions" &&
            offer.methods.includes("POST") &&
            offer.url.endsWith("/chat/completions"),
        )
      : undefined;
  if (
    provider.id === "vercel-ai-gateway" &&
    id === "vercel-ai-gateway/anthropic/claude-sonnet-4.6"
  ) {
    // Frozen Vercel row uses the native Anthropic SDK, even when Chat is also
    // offered. The SDK appends /v1/messages; the older /messages route cannot
    // serve it. Require the key's exact mapped native offer, without Chat fallback.
    const messages =
      upstream === "anthropic/claude-sonnet-4.6" &&
      capabilities.includes("llm.messages") &&
      provider.httpOffers.find(
        (offer) =>
          offer.routeKind === "native" &&
          offer.endpoint === "messages" &&
          offer.model?.id === id &&
          offer.model.upstream === upstream &&
          offer.requestFormat === "anthropic.messages" &&
          offer.responseFormat === "anthropic.messages" &&
          offer.methods.includes("POST") &&
          offer.url === `${rootUrl}/v1/native/vercel-ai-gateway/v1/messages`,
      );
    if (!messages) {
      return undefined;
    }
    api = "anthropic-messages";
    endpoint = messages.endpoint;
    baseUrl = messages.url.slice(0, -"/v1/messages".length);
    upstreamModel = upstream;
  } else if (cohereChat) {
    api = "openai-completions";
    baseUrl = cohereChat.url.slice(0, -"/chat/completions".length);
    upstreamModel = upstream;
  } else if (provider.id === "cohere") {
    // Native v2 is a different wire contract; it must not acquire a compatibility alias.
    return undefined;
  } else if (provider.openaiCompatible && capabilities.includes("llm.responses")) {
    api = "openai-responses";
    endpoint = "responses";
    baseUrl = `${rootUrl}/v1`;
  } else if (provider.openaiCompatible && capabilities.includes("llm.chat")) {
    api = "openai-completions";
    endpoint = "chat_completions";
    baseUrl = `${rootUrl}/v1`;
  } else if (
    capabilities.includes("llm.messages") &&
    provider.routes.some(
      (route) => route.methods.includes("POST") && route.requestFormat === "anthropic.messages",
    )
  ) {
    api = "anthropic-messages";
    endpoint = provider.routes.find(
      (route) => route.methods.includes("POST") && route.requestFormat === "anthropic.messages",
    )?.endpoint;
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
    endpoint = googleRoute.endpoint;
    baseUrl = `${rootUrl}${provider.nativeBaseUrl}${googleRoute.path.slice(0, modelPathIndex)}`;
    upstreamModel = upstream;
  }

  const endpointFacts =
    native?.version === "clawrouter.native-capabilities.v1" && endpoint
      ? asOptionalRecord(asOptionalRecord(native.endpoints)?.[endpoint])
      : undefined;
  const endpointMaxTokens = asPositiveSafeInteger(endpointFacts?.maxOutputTokens);
  const pricingMaxTokens = asPositiveSafeInteger(pricing?.defaultMaxOutputTokens);

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
    ...(provider.id === "mistral" && api === "openai-completions"
      ? { ...MISTRAL_MODEL_TRANSPORT_PATCH, supportsReasoningEffort: false }
      : {}),
    ...(provider.id === "xai"
      ? { ...XAI_TOOL_MODEL_COMPAT, supportsReasoningEffort: Boolean(supportedReasoningEfforts) }
      : {}),
    ...(supportedReasoningEfforts
      ? { supportsReasoningEffort: true, supportedReasoningEfforts }
      : {}),
  };

  return {
    id,
    name: normalizeOptionalString(row?.displayName) ?? `${provider.displayName} · ${modelLabel}`,
    api,
    baseUrl,
    // Reaching this point proves this credential grants a compatible chat route.
    // Static typed-only support must not veto that independent grant.
    inference: {
      ...(provider.id === "openai" && id === "openai/gpt-6-luna" && api === "openai-responses"
        ? decisionCapabilities
        : {}),
      chat: true,
    },
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
      parseCatalogInput(endpointFacts?.input) ??
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
    contextWindow:
      asPositiveSafeInteger(endpointFacts?.contextWindow) ??
      asPositiveSafeInteger(pricing?.maxInputTokens) ??
      DEFAULT_CONTEXT_WINDOW,
    ...(asPositiveSafeInteger(endpointFacts?.contextTokens)
      ? { contextTokens: asPositiveSafeInteger(endpointFacts?.contextTokens) }
      : {}),
    // A native output ceiling never raises the router's reservation default.
    maxTokens:
      endpointMaxTokens && pricingMaxTokens
        ? Math.min(endpointMaxTokens, pricingMaxTokens)
        : (endpointMaxTokens ?? pricingMaxTokens ?? DEFAULT_MAX_TOKENS),
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
    readRows: (body) => readCatalogRows(body, `${rootUrl}/v1`),
    ttlMs: CATALOG_CACHE_TTL_MS,
    auditContext: "clawrouter-model-discovery",
  });
  const providers = rows
    .map(parseCatalogProvider)
    .filter((provider): provider is CatalogProvider => Boolean(provider));
  const apiKey = params.apiKey;
  const resolveNativeModelFacts = await loadBundledModelIdentityFactsResolver();
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
  return {
    baseUrl: `${rootUrl}/v1`,
    api: "openai-responses",
    apiKey,
    models: [...models.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
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
  // OpenAI Responses treats omitted tool strictness as strict, so every optional tool input
  // becomes required. Configured and catalog rows both dispatch here; declaring support makes
  // the compatible-route policy send explicit strict=false.
  const prepared =
    model.api === "openai-responses" &&
    model.id.startsWith("openai/") &&
    model.compat?.supportsStrictMode === undefined
      ? { ...model, compat: { ...model.compat, supportsStrictMode: true } }
      : model;
  const route = readRouteMetadata(prepared.params);
  if (!route) {
    return prepared;
  }
  return {
    ...prepared,
    params: stripRouteMetadata(prepared.params),
    ...(route.upstreamModel && route.upstreamModel !== model.id ? { id: route.upstreamModel } : {}),
  };
}
