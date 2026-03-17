import {
  buildBytePlusModelDefinition,
  BYTEPLUS_BASE_URL,
  BYTEPLUS_CODING_BASE_URL,
  BYTEPLUS_CODING_MODEL_CATALOG,
  BYTEPLUS_MODEL_CATALOG,
} from "../../src/agents/byteplus-models.js";
import type { ModelProviderConfig } from "../../src/config/types.models.js";

export function buildBytePlusProvider(): ModelProviderConfig {
  return {
    baseUrl: BYTEPLUS_BASE_URL,
    api: "openai-completions",
    models: BYTEPLUS_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  };
}

export function buildBytePlusCodingProvider(): ModelProviderConfig {
  return {
    baseUrl: BYTEPLUS_CODING_BASE_URL,
    api: "openai-completions",
    models: BYTEPLUS_CODING_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  };
}
