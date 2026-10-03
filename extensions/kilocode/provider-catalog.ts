import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { discoverKilocodeModels, KILOCODE_BASE_URL } from "./provider-models.js";

export function buildKilocodeProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "kilocode",
    catalog: manifest.modelCatalog.providers.kilocode,
  });
}

export async function buildKilocodeProviderWithDiscovery(
  options: { discoveryMode?: "strict" } = {},
): Promise<ModelProviderConfig> {
  return {
    baseUrl: KILOCODE_BASE_URL,
    api: "openai-completions",
    models: await discoverKilocodeModels(options),
  };
}
