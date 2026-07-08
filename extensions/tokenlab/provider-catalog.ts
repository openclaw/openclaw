// TokenLab provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildTokenLabModelDefinition,
  TOKENLAB_BASE_URL,
  TOKENLAB_MODEL_CATALOG,
} from "./models.js";

export function buildTokenLabProvider(): ModelProviderConfig {
  return {
    baseUrl: TOKENLAB_BASE_URL,
    api: "openai-completions",
    models: TOKENLAB_MODEL_CATALOG.map(buildTokenLabModelDefinition),
  };
}
