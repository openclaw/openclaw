// CoreWeave provider builders for static and dynamically discovered catalogs.
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  COREWEAVE_BASE_URL,
  COREWEAVE_MODEL_CATALOG,
  buildCoreweaveModelDefinition,
  discoverCoreweaveModels,
} from "./models.js";

/** Builds the static CoreWeave provider catalog from bundled manifest metadata. */
export function buildStaticCoreweaveProvider(): ModelProviderConfig {
  return {
    baseUrl: COREWEAVE_BASE_URL,
    api: "openai-completions",
    models: COREWEAVE_MODEL_CATALOG.map(buildCoreweaveModelDefinition),
  };
}

/** Builds the CoreWeave provider with live model discovery, falling back to static. */
export async function buildCoreweaveProvider(
  apiKey?: string,
  project?: string,
): Promise<ModelProviderConfig> {
  const models = await discoverCoreweaveModels(apiKey, project);
  return {
    baseUrl: COREWEAVE_BASE_URL,
    api: "openai-completions",
    models,
  };
}
