import type { ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
  DEEPINFRA_DEFAULT_COST,
  DEEPINFRA_DEFAULT_MAX_TOKENS,
  DEEPINFRA_MODEL_CATALOG,
} from "../providers/deepinfra-shared.js";

const log = createSubsystemLogger("deepinfra-models");

export const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}models`;

const DISCOVERY_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// API response types (DeepInfra OpenAI-compatible /models schema)
// ---------------------------------------------------------------------------

interface DeepInfraModelPricing {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
}

interface DeepInfraModelMetadata {
  description?: string;
  context_length?: number;
  max_tokens?: number;
  pricing?: DeepInfraModelPricing;
  /** e.g. ["vision", "reasoning_effort", "prompt_cache"] */
  tags?: string[];
}

interface DeepInfraModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  metadata: DeepInfraModelMetadata | null;
}

interface DeepInfraModelsResponse {
  data: DeepInfraModelEntry[];
}

// ---------------------------------------------------------------------------
// Model parsing
// ---------------------------------------------------------------------------

function parseModality(metadata: DeepInfraModelMetadata): Array<"text" | "image"> {
  const hasVision = metadata.tags?.includes("vision") ?? false;
  return hasVision ? ["text", "image"] : ["text"];
}

function parseReasoning(metadata: DeepInfraModelMetadata): boolean {
  return metadata.tags?.includes("reasoning_effort") ?? false;
}

function toModelDefinition(entry: DeepInfraModelEntry): ModelDefinitionConfig {
  // metadata is guaranteed non-null at call site
  const meta = entry.metadata!;
  return {
    id: entry.id,
    name: entry.id,
    reasoning: parseReasoning(meta),
    input: parseModality(meta),
    cost: {
      input: meta.pricing?.input_tokens ?? 0,
      output: meta.pricing?.output_tokens ?? 0,
      cacheRead: meta.pricing?.cache_read_tokens ?? 0,
      cacheWrite: 0,
    },
    contextWindow: meta.context_length ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: meta.max_tokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// Static fallback
// ---------------------------------------------------------------------------

function buildStaticCatalog(): ModelDefinitionConfig[] {
  return DEEPINFRA_MODEL_CATALOG.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: DEEPINFRA_DEFAULT_COST,
    contextWindow: model.contextWindow ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
  }));
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover models from the DeepInfra API with fallback to static catalog.
 * Skips models with null metadata (embeddings, image-gen, etc.).
 */
export async function discoverDeepInfraModels(): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return buildStaticCatalog();
  }

  try {
    const response = await fetch(DEEPINFRA_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
      return buildStaticCatalog();
    }

    const data = (await response.json()) as DeepInfraModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      log.warn("No models found from DeepInfra API, using static catalog");
      return buildStaticCatalog();
    }

    const models: ModelDefinitionConfig[] = [];
    const discoveredIds = new Set<string>();

    for (const entry of data.data) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id || discoveredIds.has(id)) {
        continue;
      }
      // Skip non-completion models (embeddings, image-gen, etc.)
      if (entry.metadata === null) {
        continue;
      }
      try {
        models.push(toModelDefinition(entry));
        discoveredIds.add(id);
      } catch (e) {
        log.warn(`Skipping malformed model entry "${id}": ${String(e)}`);
      }
    }

    return models.length > 0 ? models : buildStaticCatalog();
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return buildStaticCatalog();
  }
}
