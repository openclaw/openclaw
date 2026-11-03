import { isStringArray } from "openclaw/plugin-sdk/collection-input-runtime";
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { isProviderApiKeyConfiguredAsync } from "openclaw/plugin-sdk/provider-auth";
import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { getCachedLiveCatalogValue } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asPositiveSafeInteger, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEEPINFRA_BASE_URL, type DeepInfraSurfaceModel } from "./media-models.js";
import { parseDeepInfraPricingCatalog } from "./pricing-api.js";
import {
  DEEPINFRA_MODEL_CATALOG,
  buildDeepInfraModelDefinition,
} from "./provider-static-catalog.js";

const log = createSubsystemLogger("deepinfra-models");

const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}/models?sort_by=openclaw&filter=with_meta`;
const DEEPINFRA_PRICING_URL = "https://api.deepinfra.com/models/list";

const DEEPINFRA_DEFAULT_CONTEXT_WINDOW = 128000;
const DEEPINFRA_DEFAULT_MAX_TOKENS = 8192;

const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

type DeepInfraDiscoveryOptions = {
  hasApiKey?: boolean;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  discoveryMode?: "strict" | "advisory";
};

type DeepInfraDiscoveredModel = Pick<
  DeepInfraSurfaceModel,
  "id" | "name" | "tags" | "contextWindow" | "maxTokens"
>;

interface DeepInfraAgentModelEntry {
  id: string;
  metadata: {
    context_length?: number | null;
    max_tokens?: number | null;
    tags?: string[];
  } | null;
}

interface DeepInfraDiscoveredCatalog {
  chat: DeepInfraDiscoveredModel[];
  vlm: DeepInfraDiscoveredModel[];
  imageGen: DeepInfraDiscoveredModel[];
  videoGen: DeepInfraDiscoveredModel[];
}

function entryToSurfaceModel(entry: DeepInfraAgentModelEntry): DeepInfraDiscoveredModel | null {
  const id = typeof entry?.id === "string" ? entry.id.trim() : "";
  if (!id) {
    return null;
  }
  const metadata = entry.metadata;
  if (metadata === null) {
    return null;
  }
  if (!isRecord(metadata) || !isStringArray(metadata.tags)) {
    throw new Error("DeepInfra model metadata discovery unavailable.");
  }
  return {
    id,
    name: id,
    tags: metadata.tags,
    contextWindow: asPositiveSafeInteger(metadata.context_length),
    maxTokens: asPositiveSafeInteger(metadata.max_tokens),
  };
}

function chatSurfaceModelToModelDefinition(
  model: DeepInfraDiscoveredModel,
): Omit<ModelDefinitionConfig, "cost"> {
  const manifestModel = DEEPINFRA_MODEL_CATALOG.find((entry) => entry.id === model.id);
  const input: Array<"text" | "image"> = model.tags.includes("vlm") ? ["text", "image"] : ["text"];
  const reasoning = model.tags.includes("reasoning") || model.tags.includes("reasoning_effort");
  return {
    id: model.id,
    name: model.name,
    reasoning: manifestModel?.reasoning ?? reasoning,
    input,
    ...(manifestModel?.compat ? { compat: manifestModel.compat } : {}),
    contextWindow: model.contextWindow ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
  };
}

async function canDiscoverDeepInfra(options?: DeepInfraDiscoveryOptions): Promise<boolean> {
  if (options?.hasApiKey !== undefined) {
    return options.hasApiKey;
  }
  const env = options?.env ?? process.env;
  const fromEnv = env.DEEPINFRA_API_KEY;
  return (
    Boolean(fromEnv?.trim()) ||
    (await isProviderApiKeyConfiguredAsync({ provider: "deepinfra", agentDir: options?.agentDir }))
  );
}

// Keep pre-auth offline; successful discovery shares the five-minute live catalog cache.
export async function discoverDeepInfraSurfaces(
  options?: DeepInfraDiscoveryOptions,
): Promise<DeepInfraDiscoveredCatalog | null> {
  if (await canDiscoverDeepInfra(options)) {
    try {
      return await loadDeepInfraSurfaces();
    } catch (error) {
      log.warn(`Model metadata discovery unavailable: ${String(error)}`);
    }
  }
  return null;
}

async function loadDeepInfraSurfaces(): Promise<DeepInfraDiscoveredCatalog> {
  return getCachedLiveCatalogValue({
    keyParts: ["deepinfra", "surfaces", DEEPINFRA_MODELS_URL],
    ttlMs: DISCOVERY_CACHE_TTL_MS,
    load: async () => {
      const data = await fetchLiveProviderModelRows({
        providerId: "deepinfra",
        endpoint: DEEPINFRA_MODELS_URL,
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        auditContext: "deepinfra-model-discovery",
        fetchGuard: (params) => fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode(params)),
      });
      const seenIds = new Set<string>();
      const surfaceModels: DeepInfraDiscoveredModel[] = [];
      for (const entry of data) {
        const model = entryToSurfaceModel(entry as DeepInfraAgentModelEntry);
        if (!model || seenIds.has(model.id)) {
          continue;
        }
        seenIds.add(model.id);
        surfaceModels.push(model);
      }
      if (data.length > 0 && surfaceModels.length === 0) {
        throw new Error("DeepInfra model metadata discovery unavailable.");
      }
      const catalog: DeepInfraDiscoveredCatalog = {
        chat: [],
        vlm: [],
        imageGen: [],
        videoGen: [],
      };
      const buckets = new Map<string, DeepInfraDiscoveredModel[]>([
        ["chat", catalog.chat],
        ["vlm", catalog.vlm],
        ["image-gen", catalog.imageGen],
        ["video-gen", catalog.videoGen],
      ]);
      for (const model of surfaceModels) {
        for (const tag of new Set(model.tags)) {
          buckets.get(tag)?.push(model);
        }
      }
      return catalog;
    },
  });
}

async function discoverDeepInfraPricing() {
  return await getCachedLiveCatalogValue({
    keyParts: ["deepinfra", "native-pricing", DEEPINFRA_PRICING_URL],
    ttlMs: DISCOVERY_CACHE_TTL_MS,
    load: async () => {
      const rows = await fetchLiveProviderModelRows({
        providerId: "deepinfra",
        endpoint: DEEPINFRA_PRICING_URL,
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        auditContext: "deepinfra-pricing-discovery",
        fetchGuard: (params) => fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode(params)),
        readRows: (body) => {
          if (!Array.isArray(body)) {
            throw new Error("Native DeepInfra pricing response must be an array");
          }
          return body;
        },
      });
      const prices = parseDeepInfraPricingCatalog(rows);
      if (!prices) {
        throw new Error("Native DeepInfra pricing is malformed or has no usable schedules");
      }
      return prices;
    },
  });
}

export async function discoverDeepInfraModels(
  options?: DeepInfraDiscoveryOptions,
): Promise<ModelDefinitionConfig[]> {
  if (!(await canDiscoverDeepInfra(options))) {
    return DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition);
  }
  const strict = options?.discoveryMode !== "advisory";
  // Resolve auth once and load independent public facts concurrently within the discovery deadline.
  // Finish both request releases before publishing; media only loads the projection.
  const [metadata, pricing] = await Promise.allSettled([
    loadDeepInfraSurfaces(),
    discoverDeepInfraPricing(),
  ]);
  if (metadata.status === "rejected") {
    if (strict) {
      throw metadata.reason;
    }
    if (pricing.status === "rejected") {
      return DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition);
    }
  }
  const catalog = metadata.status === "fulfilled" ? metadata.value : undefined;
  const chatModels = catalog ? (catalog.chat.length > 0 ? catalog.chat : catalog.vlm) : [];
  // No price schedule is needed to publish an authoritative empty chat inventory.
  if (strict && chatModels.length === 0) {
    return [];
  }
  if (strict && pricing.status === "rejected") {
    throw pricing.reason;
  }
  const prices = pricing.status === "fulfilled" ? pricing.value : undefined;
  const models = chatModels.map(chatSurfaceModelToModelDefinition);
  if (!strict) {
    const discovered = new Set(models.map((model) => model.id));
    models.push(...DEEPINFRA_MODEL_CATALOG.filter((model) => !discovered.has(model.id)));
  }
  const unknownPrices = models.filter((model) => !prices?.has(model.id)).length;
  if (unknownPrices > 0) {
    log.warn(
      `Native pricing unavailable or qualified for ${unknownPrices} models; keeping metadata with unknown estimates. Configure explicit model costs if needed.`,
    );
  }
  // Runtime requires zeros for unknown prices; this is not evidence of free billing.
  return models.map((model) =>
    buildDeepInfraModelDefinition({
      ...model,
      cost: prices?.get(model.id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  );
}
