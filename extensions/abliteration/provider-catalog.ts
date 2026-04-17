import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  ABLITERATION_BASE_URL,
  ABLITERATION_MODEL_CATALOG,
  buildAbliterationModelDefinition,
} from "./models.js";

export function buildAbliterationProvider(): ModelProviderConfig {
  return {
    baseUrl: ABLITERATION_BASE_URL,
    api: "anthropic-messages",
    models: ABLITERATION_MODEL_CATALOG.map(buildAbliterationModelDefinition),
  };
}
