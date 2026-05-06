import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { OCI_GENAI_MODELS, type OciGenAIModelEntry } from "./models.js";
import { buildOciGenAIOpenAIBaseUrl, DEFAULT_OCI_GENAI_REGION, type OciRegion } from "./regions.js";

function toCatalogModelInputs(entry: OciGenAIModelEntry): ("text" | "image")[] {
  return entry.vision ? ["text", "image"] : ["text"];
}

export function buildOciCatalogModels(): ModelProviderConfig["models"] {
  return OCI_GENAI_MODELS.map((entry) => ({
    id: entry.id,
    name: entry.name,
    input: toCatalogModelInputs(entry),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    reasoning: entry.reasoning,
    cost: {
      input: entry.cost.input,
      output: entry.cost.output,
      cacheRead: entry.cost.cacheRead ?? entry.cost.input,
      cacheWrite: entry.cost.cacheWrite ?? entry.cost.output,
    },
  }));
}

export function buildOciProvider(
  region: OciRegion = DEFAULT_OCI_GENAI_REGION,
): ModelProviderConfig {
  return {
    baseUrl: buildOciGenAIOpenAIBaseUrl(region),
    api: "openai-completions",
    models: buildOciCatalogModels(),
  };
}
