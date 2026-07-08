// TokenLab plugin module implements models behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const TOKENLAB_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "tokenlab",
  catalog: manifest.modelCatalog.providers.tokenlab,
});

export const TOKENLAB_BASE_URL = TOKENLAB_MANIFEST_PROVIDER.baseUrl;
export const TOKENLAB_MODEL_CATALOG: ModelDefinitionConfig[] = TOKENLAB_MANIFEST_PROVIDER.models;
export const TOKENLAB_DEFAULT_MODEL_REF = "tokenlab/gpt-5.5";

export function buildTokenLabModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
    input: [...model.input],
    cost: { ...model.cost },
  };
}
