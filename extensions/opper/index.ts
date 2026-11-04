import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyOpperConfig, OPPER_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { OPPER_LIVE_MODEL_DISCOVERY } from "./provider-catalog.js";
import { OPPER_PROVIDER_ID } from "./provider-models.js";

export default defineSingleProviderPluginEntry({
  id: OPPER_PROVIDER_ID,
  name: "Opper Provider",
  description: "Bundled Opper provider plugin",
  manifest,
  provider: {
    label: "Opper",
    docsPath: "/providers/opper",
    manifestAuth: {
      defaultModel: OPPER_DEFAULT_MODEL_REF,
      applyConfig: applyOpperConfig,
    },
    catalog: {
      discoveryMode: "strict",
      liveModelDiscovery: OPPER_LIVE_MODEL_DISCOVERY,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: OPPER_PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({ family: "passthrough-gemini" }),
  },
});
