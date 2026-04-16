import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildNebiusModelDefinition,
  NEBIUS_BASE_URL,
  NEBIUS_MODEL_CATALOG,
} from "./models.js";

export function buildNebiusProvider(): ModelProviderConfig {
  return {
    baseUrl: NEBIUS_BASE_URL,
    api: "openai-completions",
    models: NEBIUS_MODEL_CATALOG.map(buildNebiusModelDefinition),
  };
}
