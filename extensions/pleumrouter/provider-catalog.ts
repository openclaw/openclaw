import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  PLEUMROUTER_BASE_URL,
  PLEUMROUTER_MODEL_CATALOG,
  buildPleumrouterModelDefinition,
} from "./models.js";

export function buildPleumrouterProvider(): ModelProviderConfig {
  return {
    baseUrl: PLEUMROUTER_BASE_URL,
    api: "openai-completions",
    models: PLEUMROUTER_MODEL_CATALOG.map(buildPleumrouterModelDefinition),
  };
}
