// CoreWeave Serverless Inference model catalog plus live model discovery.
// Endpoint is still the W&B inference host after the CoreWeave rebrand.
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const log = createSubsystemLogger("coreweave-models");

const COREWEAVE_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "coreweave",
  catalog: manifest.modelCatalog.providers.coreweave,
});

/** Base URL for CoreWeave Serverless Inference (OpenAI-compatible). */
export const COREWEAVE_BASE_URL = COREWEAVE_MANIFEST_PROVIDER.baseUrl;
const COREWEAVE_DEFAULT_MODEL_ID = "moonshotai/Kimi-K2.6";
/** Default CoreWeave model ref used for onboarding. */
export const COREWEAVE_DEFAULT_MODEL_REF = `coreweave/${COREWEAVE_DEFAULT_MODEL_ID}`;

const COREWEAVE_DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COREWEAVE_DEFAULT_CONTEXT_WINDOW = 131_072;
const COREWEAVE_DEFAULT_MAX_TOKENS = 32_768;
const COREWEAVE_DISCOVERY_TIMEOUT_MS = 10_000;
const COREWEAVE_DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

/** Bundled CoreWeave catalog rows, sourced from the manifest single source of truth. */
export const COREWEAVE_MODEL_CATALOG: ModelDefinitionConfig[] = COREWEAVE_MANIFEST_PROVIDER.models;

type CoreweaveCatalogEntry = Omit<ModelDefinitionConfig, "cost"> & {
  cost?: ModelDefinitionConfig["cost"];
};

/** Adds CoreWeave provider compat metadata and default cost to one catalog row. */
export function buildCoreweaveModelDefinition(entry: CoreweaveCatalogEntry): ModelDefinitionConfig {
  return {
    ...entry,
    cost: entry.cost ?? COREWEAVE_DEFAULT_COST,
    compat: {
      supportsUsageInStreaming: false,
      ...entry.compat,
    },
  };
}

function staticCoreweaveModelDefinitions(): ModelDefinitionConfig[] {
  return COREWEAVE_MODEL_CATALOG.map(buildCoreweaveModelDefinition);
}

interface CoreweaveModelRow {
  id?: unknown;
}

/**
 * Cache key for live `/models` discovery. Scopes by endpoint, the optional
 * project (the openai-project scope applies to the listing request too), and the
 * actual credential — so distinct keys or projects never share a cached row set.
 * Keying on the raw credential is safe because the runtime hashes key parts.
 */
export function coreweaveModelRowsCacheKey(params: {
  apiKey?: string;
  project?: string;
}): readonly string[] {
  return [
    "coreweave",
    "model-rows",
    `${COREWEAVE_BASE_URL}/models`,
    params.apiKey ?? "",
    params.project ?? "",
  ];
}

async function fetchCoreweaveModelRows(
  apiKey?: string,
  project?: string,
): Promise<readonly unknown[]> {
  return await getCachedLiveProviderModelRows({
    providerId: "coreweave",
    endpoint: `${COREWEAVE_BASE_URL}/models`,
    discoveryApiKey: apiKey,
    timeoutMs: COREWEAVE_DISCOVERY_TIMEOUT_MS,
    ttlMs: COREWEAVE_DISCOVERY_CACHE_TTL_MS,
    cacheKeyParts: coreweaveModelRowsCacheKey({ apiKey, project }),
    buildRequestHeaders: ({ discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
      ...(project ? { "openai-project": project } : {}),
    }),
    // Do not pin an empty/transient response for the full TTL; let recovery refresh.
    shouldCacheRows: (rows) => rows.length > 0,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(COREWEAVE_BASE_URL),
    auditContext: "coreweave-model-discovery",
  });
}

/**
 * Discovers CoreWeave models from the live `/models` endpoint, mapping known ids
 * onto the rich manifest catalog and minting lean rows for ids we have not seen.
 * Falls back to the static catalog whenever discovery is unavailable.
 */
export async function discoverCoreweaveModels(
  apiKey?: string,
  project?: string,
): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return staticCoreweaveModelDefinitions();
  }

  try {
    const rows = await fetchCoreweaveModelRows(normalizeOptionalString(apiKey), project);
    if (rows.length === 0) {
      log.warn("No models in /models response, using static catalog");
      return staticCoreweaveModelDefinitions();
    }

    const catalogById = new Map(COREWEAVE_MODEL_CATALOG.map((m) => [m.id, m]));
    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];
    for (const row of rows as CoreweaveModelRow[]) {
      const id = normalizeOptionalString(row?.id);
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const known = catalogById.get(id);
      if (known) {
        models.push(buildCoreweaveModelDefinition(known));
        continue;
      }
      // Live id with no bundled metadata: infer reasoning from the id and keep a safe default shape.
      const lowerId = normalizeLowercaseStringOrEmpty(id);
      const reasoning = lowerId.includes("thinking") || lowerId.includes("reason");
      models.push(
        buildCoreweaveModelDefinition({
          id,
          name: id,
          reasoning,
          input: ["text"],
          contextWindow: COREWEAVE_DEFAULT_CONTEXT_WINDOW,
          maxTokens: COREWEAVE_DEFAULT_MAX_TOKENS,
        }),
      );
    }

    return models.length > 0 ? models : staticCoreweaveModelDefinitions();
  } catch (error) {
    if (error instanceof LiveModelCatalogHttpError) {
      log.warn(`Failed to discover models: HTTP ${error.status}, using static catalog`);
      return staticCoreweaveModelDefinitions();
    }
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticCoreweaveModelDefinitions();
  }
}
