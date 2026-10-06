import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { CHUTES_BASE_URL, CHUTES_MODEL_CATALOG, discoverChutesModels } from "./models.js";

export function buildStaticChutesProvider(): ModelProviderConfig {
  return {
    baseUrl: CHUTES_BASE_URL,
    api: "openai-completions",
    models: structuredClone(CHUTES_MODEL_CATALOG),
  };
}

export async function buildChutesProvider(
  accessToken?: string,
  options: { discoveryMode?: "strict" } = {},
): Promise<ModelProviderConfig> {
  return {
    baseUrl: CHUTES_BASE_URL,
    api: "openai-completions",
    models: await discoverChutesModels(accessToken, options),
  };
}
