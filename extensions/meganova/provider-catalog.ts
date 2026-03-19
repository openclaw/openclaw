import {
  buildMeganovaModelDefinition,
  MEGANOVA_BASE_URL,
  MEGANOVA_MODEL_CATALOG,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-models";

export async function buildMeganovaProvider(): Promise<ModelProviderConfig> {
  return {
    baseUrl: MEGANOVA_BASE_URL,
    api: "openai-completions",
    models: MEGANOVA_MODEL_CATALOG.map(buildMeganovaModelDefinition),
  };
}
