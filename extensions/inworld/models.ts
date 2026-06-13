import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const log = createSubsystemLogger("inworld-models");

export const INWORLD_BASE_URL = "https://api.inworld.ai";
export const INWORLD_COMPLETIONS_URL = `${INWORLD_BASE_URL}/v1`;
export const INWORLD_DEFAULT_MODEL_ID = "auto";
export const INWORLD_DEFAULT_MODEL_REF = `inworld/${INWORLD_DEFAULT_MODEL_ID}`;

const INWORLD_DEFAULT_CONTEXT_WINDOW = 128_000;
const INWORLD_DEFAULT_MAX_TOKENS = 4096;

export const INWORLD_FALLBACK_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "auto",
    name: "Inworld Auto",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: { supportsTools: true },
  },
];

export interface InworldCatalogModel {
  model?: string;
  provider?: string;
  pricing?: {
    promptToken?: number;
    completionToken?: number;
    promptCacheReadToken?: number;
    promptCacheWriteToken?: number;
  };
  spec?: {
    inputModalities?: string[];
    contextLength?: number;
    maxCompletionTokens?: number;
    supportedParameters?: string[];
    capabilities?: {
      functionCalling?: boolean;
      reasoning?: boolean;
      vision?: boolean;
      promptCaching?: boolean;
      reasoningCapability?: { supportedLevels?: string[] };
    };
  };
  isSupported?: boolean;
}

// Process-lifetime cache; refresh requires restart or openclaw doctor.
let discoveredModels: ModelDefinitionConfig[] | undefined;
let discoveredModelMap: Map<string, ModelDefinitionConfig> | undefined;
const inworldReasoningLevels = new Map<string, readonly string[]>();
const inworldCacheTtl = new Set<string>();

export function getInworldReasoningLevels(modelId: string): readonly string[] | undefined {
  return inworldReasoningLevels.get(modelId);
}

export function isInworldCacheTtlModel(modelId: string): boolean {
  return inworldCacheTtl.has(modelId);
}

// User-facing first-party ids look like `models/<NAME>`; the wire `model`
// sent to api.inworld.ai must be `inworld/models/<NAME>`.
export function toInworldWireModelId(modelId: string): string {
  return modelId.startsWith("models/") ? `inworld/${modelId}` : modelId;
}

function buildModelMap(models: ModelDefinitionConfig[]): Map<string, ModelDefinitionConfig> {
  const map = new Map<string, ModelDefinitionConfig>();
  for (const m of models) {
    map.set(m.id, m);
  }
  return map;
}

export function getInworldModelCapabilities(modelId: string): ModelDefinitionConfig | undefined {
  if (!discoveredModelMap && !discoveredModels) {
    discoveredModelMap = buildModelMap(INWORLD_FALLBACK_CATALOG);
  }
  return discoveredModelMap?.get(modelId);
}

export function parseInworldModel(entry: InworldCatalogModel): ModelDefinitionConfig | undefined {
  const modelName = normalizeOptionalString(entry.model);
  if (!modelName || entry.isSupported === false) {
    return undefined;
  }
  // First-party Inworld models keep the bare "models/<NAME>" form so the
  // user ref is `inworld/models/<NAME>` (single prefix). Other providers
  // use "<provider>/<model>" so the user ref is `inworld/<provider>/<model>`.
  const upstreamProvider = normalizeOptionalString(entry.provider);
  const id =
    !upstreamProvider || upstreamProvider === "inworld"
      ? modelName
      : `${upstreamProvider}/${modelName}`;

  const spec = entry.spec;
  const pricing = entry.pricing;
  const capabilities = spec?.capabilities;

  const input: Array<"text" | "image"> = ["text"];
  if (spec?.inputModalities?.includes("image") || capabilities?.vision) {
    input.push("image");
  }

  // Inworld pricing is per-token USD; openclaw expects per-million-token.
  const scale = 1_000_000;

  const levels = capabilities?.reasoningCapability?.supportedLevels;
  if (levels && levels.length > 0) {
    inworldReasoningLevels.set(id, levels);
  }
  if (capabilities?.promptCaching) {
    inworldCacheTtl.add(id);
  }

  return {
    id,
    name: id,
    reasoning: capabilities?.reasoning ?? false,
    input,
    cost: {
      input: (pricing?.promptToken ?? 0) * scale,
      output: (pricing?.completionToken ?? 0) * scale,
      cacheRead: (pricing?.promptCacheReadToken ?? 0) * scale,
      cacheWrite: (pricing?.promptCacheWriteToken ?? 0) * scale,
    },
    contextWindow: asPositiveSafeInteger(spec?.contextLength) ?? INWORLD_DEFAULT_CONTEXT_WINDOW,
    maxTokens: asPositiveSafeInteger(spec?.maxCompletionTokens) ?? INWORLD_DEFAULT_MAX_TOKENS,
    ...(capabilities?.functionCalling != null
      ? { compat: { supportsTools: capabilities.functionCalling } }
      : {}),
  };
}

export async function discoverInworldModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  if (discoveredModels) {
    return discoveredModels;
  }

  const trimmedKey = normalizeOptionalString(apiKey) ?? "";
  if (!trimmedKey) {
    log.debug("No API key available, using fallback catalog");
    return INWORLD_FALLBACK_CATALOG;
  }

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${INWORLD_BASE_URL}/llm/v1alpha/models`,
      init: {
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Basic ${trimmedKey}` },
      },
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(INWORLD_BASE_URL),
      auditContext: "inworld-model-discovery",
    });

    try {
      if (!response.ok) {
        log.warn(`GET /llm/v1alpha/models: HTTP ${response.status}, using fallback`);
        return INWORLD_FALLBACK_CATALOG;
      }

      const body = (await response.json()) as { models?: InworldCatalogModel[] };
      const rawModels = body?.models;
      if (!Array.isArray(rawModels) || rawModels.length === 0) {
        return INWORLD_FALLBACK_CATALOG;
      }

      const seen = new Set<string>();
      const models: ModelDefinitionConfig[] = [];
      const modelMap = new Map<string, ModelDefinitionConfig>();

      for (const entry of rawModels) {
        const parsed = parseInworldModel(entry);
        if (!parsed || seen.has(parsed.id)) {
          continue;
        }
        seen.add(parsed.id);
        models.push(parsed);
        modelMap.set(parsed.id, parsed);
      }

      if (models.length > 0) {
        discoveredModels = models;
        discoveredModelMap = modelMap;
        return models;
      }
      return INWORLD_FALLBACK_CATALOG;
    } finally {
      await release();
    }
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using fallback`);
    return INWORLD_FALLBACK_CATALOG;
  }
}
