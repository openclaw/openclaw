import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DEEPSEEK_MANIFEST_CATALOG = manifest.modelCatalog.providers.deepseek;
export const DEEPSEEK_BASE_URL = DEEPSEEK_MANIFEST_CATALOG.baseUrl;

export const DEEPSEEK_MODEL_CATALOG: ModelDefinitionConfig[] = buildManifestModelProviderConfig({
  providerId: "deepseek",
  catalog: DEEPSEEK_MANIFEST_CATALOG,
}).models.map((model) => Object.assign(model, { api: "openai-completions" }));

// Every bundled DeepSeek row is a V4 model; its thinking profile comes from the row.
const DEEPSEEK_V4_MODEL_IDS = new Set(DEEPSEEK_MODEL_CATALOG.map((model) => model.id));

export function isDeepSeekV4ModelId(modelId: string): boolean {
  return DEEPSEEK_V4_MODEL_IDS.has(modelId.toLowerCase());
}

export function isDeepSeekV4ModelRef(model: { provider?: string; id: string }): boolean {
  return model.provider === "deepseek" && isDeepSeekV4ModelId(model.id);
}
