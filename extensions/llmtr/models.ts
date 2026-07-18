/**
 * LLMTR model catalog, static model definitions, and dynamic model discovery.
 */
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const log = createSubsystemLogger("llmtr-models");

const LLMTR_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "llmtr",
  catalog: manifest.modelCatalog.providers.llmtr,
});

/** Base URL for the LLMTR OpenAI-compatible gateway. */
export const LLMTR_BASE_URL = LLMTR_MANIFEST_PROVIDER.baseUrl;
/** Default LLMTR model id used for onboarding. */
export const LLMTR_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-5";
/** Default LLMTR model ref used for onboarding. */
export const LLMTR_DEFAULT_MODEL_REF = `llmtr/${LLMTR_DEFAULT_MODEL_ID}`;

/**
 * LLMTR's `/v1/models` reports only id/owner/supported_operations — no context,
 * pricing, or modality metadata. Discovered models that are not in the curated
 * manifest therefore fall back to these conservative values. Under-declaring the
 * window truncates history early instead of failing the request upstream.
 */
const LLMTR_DEFAULT_CONTEXT_WINDOW = 32768;
const LLMTR_DEFAULT_MAX_TOKENS = 8192;

/** Bundled fallback LLMTR model catalog, normalized from the plugin manifest. */
export const LLMTR_MODEL_CATALOG: ModelDefinitionConfig[] = LLMTR_MANIFEST_PROVIDER.models;

/** Adds LLMTR provider compat metadata to one model catalog entry. */
export function buildLlmtrModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
    compat: {
      ...model.compat,
      // Verified live: LLMTR never emits a usage block on streamed responses,
      // even when the request sets stream_options.include_usage. Without this
      // flag every streamed turn would report zero token usage.
      supportsUsageInStreaming: false,
    },
  };
}

interface LlmtrModelEntry {
  id?: unknown;
  owned_by?: unknown;
  supported_operations?: unknown;
}

const CACHE_TTL = 5 * 60 * 1000;

/**
 * LLMTR routes Responses-only models (OpenAI gpt-5.5+/codex, Grok 4.x, Qwen VL)
 * to `/v1/responses`. This plugin speaks `openai-completions`, so advertising
 * them would surface models that reject every request we can send.
 */
const CHAT_COMPLETIONS_OPERATION = "CHAT_COMPLETIONS";

function supportsChatCompletions(entry: LlmtrModelEntry): boolean {
  return (
    Array.isArray(entry.supported_operations) &&
    entry.supported_operations.includes(CHAT_COMPLETIONS_OPERATION)
  );
}

async function fetchLlmtrModelRows(apiKey?: string): Promise<readonly unknown[]> {
  return await getCachedLiveProviderModelRows({
    providerId: "llmtr",
    endpoint: `${LLMTR_BASE_URL}/models`,
    discoveryApiKey: apiKey,
    timeoutMs: 10_000,
    ttlMs: CACHE_TTL,
    buildRequestHeaders: ({ discoveryApiKey }) => ({
      Accept: "application/json",
      ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
    }),
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(LLMTR_BASE_URL),
    auditContext: "llmtr-model-discovery",
  });
}

/**
 * Builds a catalog entry for a discovered model, preferring curated manifest
 * metadata so hand-checked context windows survive discovery.
 */
function buildDiscoveredModel(id: string, curated: ModelDefinitionConfig | undefined) {
  if (curated) {
    return buildLlmtrModelDefinition(curated);
  }
  return buildLlmtrModelDefinition({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    contextWindow: LLMTR_DEFAULT_CONTEXT_WINDOW,
    maxTokens: LLMTR_DEFAULT_MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
}

/** Discovers LLMTR models dynamically, falling back to the bundled static catalog. */
export async function discoverLlmtrModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  const trimmedKey = normalizeOptionalString(apiKey) ?? "";
  const staticCatalog = () => LLMTR_MODEL_CATALOG.map(buildLlmtrModelDefinition);
  const curatedById = new Map(LLMTR_MODEL_CATALOG.map((model) => [model.id, model]));

  try {
    const rows = await fetchLlmtrModelRows(trimmedKey || undefined);
    if (rows.length === 0) {
      log.warn("No models in response, using static catalog");
      return staticCatalog();
    }

    const seen = new Set<string>();
    const models: ModelDefinitionConfig[] = [];

    for (const entry of rows as LlmtrModelEntry[]) {
      const id = normalizeOptionalString(entry?.id) ?? "";
      if (!id || seen.has(id) || !supportsChatCompletions(entry)) {
        continue;
      }
      seen.add(id);
      models.push(buildDiscoveredModel(id, curatedById.get(id)));
    }

    if (models.length === 0) {
      log.warn("No chat-completions models in response, using static catalog");
      return staticCatalog();
    }
    return models;
  } catch (error) {
    if (error instanceof LiveModelCatalogHttpError && error.status === 401 && trimmedKey) {
      // LLMTR serves /v1/models unauthenticated; retry keyless so a bad key
      // still yields the public catalog instead of the frozen bundled one.
      return await discoverLlmtrModels(undefined);
    }
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return staticCatalog();
  }
}
