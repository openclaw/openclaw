import type { ModelDefinitionConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  KILOCODE_BASE_URL,
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_MODEL_CATALOG,
  resolveKilocodeOrgId,
} from "../providers/kilocode-shared.js";

const log = createSubsystemLogger("kilocode-models");

export const KILOCODE_MODELS_URL = `${KILOCODE_BASE_URL}models`;

/**
 * Build the models URL for Kilocode, using an org-scoped path when an
 * organization ID is configured. This mirrors the behavior of opencode's
 * `fetchKiloModels`, which routes to `/api/organizations/{orgId}/models`
 * when an org ID is present.
 *
 * KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/"
 * Org-scoped URL   = "https://api.kilo.ai/api/organizations/{orgId}/models"
 * Default URL      = "https://api.kilo.ai/api/gateway/models"
 */
export function buildKilocodeModelsUrl(orgId?: string): string {
  if (!orgId) {
    return KILOCODE_MODELS_URL;
  }
  // Strip the "gateway/" segment and substitute the org-scoped path.
  const apiBase = KILOCODE_BASE_URL.replace(/gateway\/?$/, "");
  return `${apiBase}organizations/${orgId}/models`;
}

const DISCOVERY_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Gateway response types (OpenRouter-compatible schema)
// ---------------------------------------------------------------------------

interface GatewayModelPricing {
  prompt: string;
  completion: string;
  image?: string;
  request?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  web_search?: string;
  internal_reasoning?: string;
}

interface GatewayModelEntry {
  id: string;
  name: string;
  context_length: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: {
    max_completion_tokens?: number | null;
  };
  pricing: GatewayModelPricing;
  supported_parameters?: string[];
}

interface GatewayModelsResponse {
  data: GatewayModelEntry[];
}

// ---------------------------------------------------------------------------
// Pricing conversion
// ---------------------------------------------------------------------------

/**
 * Convert per-token price (as returned by the gateway) to per-1M-token price
 * (as stored in OpenClaw's ModelDefinitionConfig.cost).
 *
 * Gateway/OpenRouter prices are per-token strings like "0.000005".
 * OpenClaw costs are per-1M-token numbers like 5.0.
 */
function toPricePerMillion(perToken: string | undefined): number {
  if (!perToken) {
    return 0;
  }
  const num = Number(perToken);
  if (!Number.isFinite(num) || num < 0) {
    return 0;
  }
  return num * 1_000_000;
}

// ---------------------------------------------------------------------------
// Model parsing
// ---------------------------------------------------------------------------

function parseModality(entry: GatewayModelEntry): Array<"text" | "image"> {
  const modalities = entry.architecture?.input_modalities;
  if (!Array.isArray(modalities)) {
    return ["text"];
  }
  const hasImage = modalities.some((m) => typeof m === "string" && m.toLowerCase() === "image");
  return hasImage ? ["text", "image"] : ["text"];
}

function parseReasoning(entry: GatewayModelEntry): boolean {
  const params = entry.supported_parameters;
  if (!Array.isArray(params)) {
    return false;
  }
  return params.includes("reasoning") || params.includes("include_reasoning");
}

function toModelDefinition(entry: GatewayModelEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name || entry.id,
    reasoning: parseReasoning(entry),
    input: parseModality(entry),
    cost: {
      input: toPricePerMillion(entry.pricing.prompt),
      output: toPricePerMillion(entry.pricing.completion),
      cacheRead: toPricePerMillion(entry.pricing.input_cache_read),
      cacheWrite: toPricePerMillion(entry.pricing.input_cache_write),
    },
    contextWindow: entry.context_length || KILOCODE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.top_provider?.max_completion_tokens ?? KILOCODE_DEFAULT_MAX_TOKENS,
  };
}

// ---------------------------------------------------------------------------
// Static fallback
// ---------------------------------------------------------------------------

function buildStaticCatalog(): ModelDefinitionConfig[] {
  return KILOCODE_MODEL_CATALOG.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: KILOCODE_DEFAULT_COST,
    contextWindow: model.contextWindow ?? KILOCODE_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? KILOCODE_DEFAULT_MAX_TOKENS,
  }));
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover models from the Kilo Gateway API with fallback to static catalog.
 * The /api/gateway/models endpoint is public and doesn't require authentication.
 * When an org ID is configured the request is routed to the org-scoped endpoint
 * (/api/organizations/{orgId}/models), which requires a Bearer token; the
 * apiKey parameter is included as Authorization: Bearer when provided.
 */
export async function discoverKilocodeModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  // Skip API discovery in test environment
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return buildStaticCatalog();
  }

  const orgId = resolveKilocodeOrgId();
  const modelsUrl = buildKilocodeModelsUrl(orgId);

  const headers: Record<string, string> = { Accept: "application/json" };
  // Org-scoped endpoints require authentication; include the Bearer token when
  // an org ID is present and an API key has been resolved.
  if (orgId && apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      log.warn(
        `Failed to discover models from ${modelsUrl}: HTTP ${response.status}, using static catalog`,
      );
      return buildStaticCatalog();
    }

    const data = (await response.json()) as GatewayModelsResponse;
    if (!Array.isArray(data.data) || data.data.length === 0) {
      log.warn("No models found from gateway API, using static catalog");
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
