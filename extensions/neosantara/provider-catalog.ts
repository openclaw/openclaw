// Neosantara provider module implements model/runtime integration.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export function buildNeosantaraProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "neosantara",
    catalog: manifest.modelCatalog.providers.neosantara,
  });
}

export function buildNeosantaraResponsesProvider(): ModelProviderConfig {
  const provider = buildNeosantaraProvider();
  return {
    ...provider,
    api: "openai-responses",
    models: provider.models.map((model) => ({
      ...model,
      api: "openai-responses",
    })),
  };
}
