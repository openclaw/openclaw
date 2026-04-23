import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildWaveSpeedModelDefinition,
  WAVESPEED_BASE_URL,
  WAVESPEED_MODEL_CATALOG,
} from "./models.js";

export function buildWaveSpeedCatalogModels(): NonNullable<ModelProviderConfig["models"]> {
  return WAVESPEED_MODEL_CATALOG.map(buildWaveSpeedModelDefinition);
}

export function buildWaveSpeedProvider(): ModelProviderConfig {
  return {
    baseUrl: WAVESPEED_BASE_URL,
    api: "openai-completions",
    models: buildWaveSpeedCatalogModels(),
  };
}
