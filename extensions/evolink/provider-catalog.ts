// EvoLink provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildEvoLinkModelDefinition, EVOLINK_BASE_URL, EVOLINK_MODEL_CATALOG } from "./models.js";

export function buildEvoLinkProvider(): ModelProviderConfig {
  return {
    baseUrl: EVOLINK_BASE_URL,
    api: "openai-completions",
    models: EVOLINK_MODEL_CATALOG.map(buildEvoLinkModelDefinition),
  };
}
