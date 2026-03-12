import type { ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  MODEL_HUB_BASE_URL,
  MODEL_HUB_DEFAULT_CONTEXT_WINDOW,
  MODEL_HUB_DEFAULT_COST,
  MODEL_HUB_DEFAULT_MAX_TOKENS,
  MODEL_HUB_MODEL_CATALOG,
} from "../providers/model-hub-shared.js";

const log = createSubsystemLogger("model-hub-models");

export const MODEL_HUB_MODELS_URL = `${MODEL_HUB_BASE_URL}/models`;

const DISCOVERY_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// OpenAI /v1/models response types
// ---------------------------------------------------------------------------

interface OpenAIModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
}

interface OpenAIModelsResponse {
  data: OpenAIModelEntry[];
  object?: string;
}

// ---------------------------------------------------------------------------
// Model parsing
// ---------------------------------------------------------------------------

function inferReasoning(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.includes("r1") ||
    lower.includes("reasoning") ||
    lower.includes("think") ||
    /\bo[134]\b/.test(lower)
  );
}

function inferImageSupport(modelId: string): Array<"text" | "image"> {
  const lower = modelId.toLowerCase();
  const hasVision =
    lower.includes("vision") ||
    lower.includes("gpt-4") ||
    lower.includes("gpt-5") ||
    lower.includes("claude") ||
    lower.includes("gemini") ||
    lower.includes("vl");
  return hasVision ? ["text", "image"] : ["text"];
}

function toModelDefinition(entry: OpenAIModelEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.id,
    reasoning: inferReasoning(entry.id),
    input: inferImageSupport(entry.id),
    cost: MODEL_HUB_DEFAULT_COST,
    contextWindow: MODEL_HUB_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MODEL_HUB_DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// Static fallback
// ---------------------------------------------------------------------------

function buildStaticCatalog(): ModelDefinitionConfig[] {
  return MODEL_HUB_MODEL_CATALOG.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: MODEL_HUB_DEFAULT_COST,
    contextWindow: model.contextWindow ?? MODEL_HUB_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? MODEL_HUB_DEFAULT_MAX_TOKENS,
  }));
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover models from the Model Hub API (`/v1/models`) with fallback to
 * the static catalog. The endpoint follows the standard OpenAI models list
 * format.
 */
export async function discoverModelHubModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return buildStaticCatalog();
  }

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(MODEL_HUB_MODELS_URL, {
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
      return buildStaticCatalog();
    }

    const data = (await response.json()) as OpenAIModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      log.warn("No models found from Model Hub API, using static catalog");
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
      try {
        models.push(toModelDefinition(entry));
        discoveredIds.add(id);
      } catch (e) {
        log.warn(`Skipping malformed model entry "${id}": ${String(e)}`);
      }
    }

    // Ensure the static fallback models are always present
    const staticModels = buildStaticCatalog();
    for (const staticModel of staticModels) {
      if (!discoveredIds.has(staticModel.id)) {
        models.unshift(staticModel);
      }
    }

    return models.length > 0 ? models : buildStaticCatalog();
  } catch (error) {
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return buildStaticCatalog();
  }
}
