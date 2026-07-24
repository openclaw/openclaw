// OpenRouter text-model catalog discovery for the interactive model picker.
import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";

const log = createSubsystemLogger("openrouter-model-catalog");
const OPENROUTER_MODELS_URL = new URL("models", `${OPENROUTER_BASE_URL}/`).href;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

type OpenRouterModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_parameters?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
};

type OpenRouterCatalogEntry = {
  provider: "openrouter";
  id: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  input: Array<"text" | "image" | "audio" | "video" | "document">;
};

function normalizeModalities(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
    : [];
}

function projectInputModalities(value: unknown): OpenRouterCatalogEntry["input"] {
  const input = new Set<OpenRouterCatalogEntry["input"][number]>(["text"]);
  for (const modality of normalizeModalities(value)) {
    switch (modality) {
      case "image":
        input.add("image");
        break;
      case "audio":
        input.add("audio");
        break;
      case "video":
        input.add("video");
        break;
      case "file":
      case "document":
        input.add("document");
        break;
    }
  }
  return [...input];
}

function supportsTextChat(model: OpenRouterModel): boolean {
  const input = normalizeModalities(model.architecture?.input_modalities);
  const output = normalizeModalities(model.architecture?.output_modalities);
  return input.includes("text") && output.includes("text");
}

function supportsReasoning(model: OpenRouterModel): boolean {
  return normalizeModalities(model.supported_parameters).some(
    (parameter) =>
      parameter === "reasoning" ||
      parameter === "reasoning_effort" ||
      parameter === "include_reasoning",
  );
}

function projectOpenRouterModel(model: OpenRouterModel): OpenRouterCatalogEntry | undefined {
  const id = normalizeOptionalString(model.id);
  if (!id || !supportsTextChat(model)) {
    return undefined;
  }
  const name = normalizeOptionalString(model.name) ?? id;
  const contextWindow = asPositiveSafeInteger(model.context_length);
  return {
    provider: "openrouter",
    id,
    name,
    ...(contextWindow ? { contextWindow } : {}),
    ...(supportsReasoning(model) ? { reasoning: true } : {}),
    input: projectInputModalities(model.architecture?.input_modalities),
  };
}

/** Loads OpenRouter's live text-chat catalog for interactive browsing. */
export async function listOpenRouterModelCatalog(): Promise<OpenRouterCatalogEntry[]> {
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: "openrouter",
      endpoint: OPENROUTER_MODELS_URL,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      ttlMs: DISCOVERY_CACHE_TTL_MS,
      auditContext: "openrouter-model-discovery",
      shouldCacheRows: (entries) => entries.length > 0,
      fetchGuard: (params) => fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode(params)),
    });
    const seen = new Set<string>();
    const models: OpenRouterCatalogEntry[] = [];
    for (const row of rows) {
      const model = projectOpenRouterModel(row as OpenRouterModel);
      if (!model || seen.has(model.id)) {
        continue;
      }
      seen.add(model.id);
      models.push(model);
    }
    return models;
  } catch (error) {
    const message =
      error instanceof LiveModelCatalogHttpError
        ? `HTTP ${error.status}`
        : error instanceof Error
          ? error.message
          : String(error);
    log.warn(`Failed to load live OpenRouter models: ${message}`);
    return [];
  }
}
