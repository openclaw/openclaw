import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyRequestyConfig, REQUESTY_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { REQUESTY_LIVE_MODEL_DISCOVERY } from "./provider-catalog.js";
import { isRequestyAnthropicModel, REQUESTY_PROVIDER_ID } from "./provider-models.js";
import { wrapRequestyProviderStream } from "./stream.js";

export default defineSingleProviderPluginEntry({
  id: REQUESTY_PROVIDER_ID,
  name: "Requesty Provider",
  description: "Bundled Requesty provider plugin",
  manifest,
  provider: {
    label: "Requesty",
    docsPath: "/providers/requesty",
    manifestAuth: {
      defaultModel: REQUESTY_DEFAULT_MODEL_REF,
      applyConfig: applyRequestyConfig,
    },
    catalog: {
      discoveryMode: "strict",
      liveModelDiscovery: REQUESTY_LIVE_MODEL_DISCOVERY,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: REQUESTY_PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
    wrapStreamFn: wrapRequestyProviderStream,
    isCacheTtlEligible: (ctx) => isRequestyAnthropicModel(ctx.modelId),
  },
});
