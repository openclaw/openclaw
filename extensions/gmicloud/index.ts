import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyGmicloudConfig, GMICLOUD_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildGmicloudProvider } from "./provider-catalog.js";

const PROVIDER_ID = "gmicloud";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "GMI Cloud Provider",
  description: "Bundled GMI Cloud provider plugin",
  provider: {
    label: "GMI Cloud",
    docsPath: "/providers/gmicloud",
    auth: [
      {
        methodId: "api-key",
        label: "GMI Cloud API key",
        hint: "API key",
        optionKey: "gmicloudApiKey",
        flagName: "--gmicloud-api-key",
        envVar: "GMI_CLOUD_API_KEY",
        promptMessage: "Enter GMI Cloud API key",
        defaultModel: GMICLOUD_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyGmicloudConfig(cfg),
        wizard: {
          groupLabel: "GMI Cloud",
        },
      },
    ],
    catalog: {
      buildProvider: buildGmicloudProvider,
    },
  },
});
