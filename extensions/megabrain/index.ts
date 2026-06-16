// MegaBrain plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyMegaBrainConfig, MEGABRAIN_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildMegaBrainProvider, buildStaticMegaBrainProvider } from "./provider-catalog.js";

const PROVIDER_ID = "megabrain";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "MegaBrain Provider",
  description: "Bundled MegaBrain provider plugin",
  provider: {
    label: "MegaBrain",
    docsPath: "/providers/megabrain",
    auth: [
      {
        methodId: "api-key",
        label: "MegaBrain API key",
        hint: "API key from getmegabrain.com",
        optionKey: "megabrainApiKey",
        flagName: "--megabrain-api-key",
        envVar: "MEGABRAIN_API_KEY",
        promptMessage: "Enter MegaBrain API key",
        defaultModel: MEGABRAIN_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMegaBrainConfig(cfg),
        wizard: {
          choiceId: "megabrain-api-key",
          groupId: "megabrain",
        },
      },
    ],
    catalog: {
      buildProvider: buildMegaBrainProvider,
      buildStaticProvider: buildStaticMegaBrainProvider,
    },
  },
});
