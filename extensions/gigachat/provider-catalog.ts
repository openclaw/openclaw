import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { GIGACHAT_PROVIDER_ID, resolveGigachatChatBaseUrl } from "./config.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export function buildGigachatProvider(config?: OpenClawConfig): ModelProviderConfig {
  const provider = buildManifestModelProviderConfig({
    providerId: GIGACHAT_PROVIDER_ID,
    catalog: manifest.modelCatalog.providers.gigachat,
  });
  return {
    ...provider,
    baseUrl: resolveGigachatChatBaseUrl(config),
  };
}
