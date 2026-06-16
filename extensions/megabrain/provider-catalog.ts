// MegaBrain provider module implements model/runtime integration.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  discoverMegaBrainModels,
  getStaticMegaBrainModelCatalog,
  MEGABRAIN_BASE_URL,
} from "./models.js";

export function buildStaticMegaBrainProvider(): ModelProviderConfig {
  return {
    baseUrl: MEGABRAIN_BASE_URL,
    api: "openai-completions",
    models: getStaticMegaBrainModelCatalog(),
  };
}

export async function buildMegaBrainProvider(): Promise<ModelProviderConfig> {
  return {
    baseUrl: MEGABRAIN_BASE_URL,
    api: "openai-completions",
    models: await discoverMegaBrainModels(),
  };
}
