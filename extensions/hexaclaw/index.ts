import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyHexaclawConfig, HEXACLAW_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildHexaclawProvider } from "./provider-catalog.js";

const PROVIDER_ID = "hexaclaw";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "HexaClaw Provider",
  description: "Bundled HexaClaw provider plugin — multi-model AI gateway",
  provider: {
    label: "HexaClaw",
    docsPath: "/providers/hexaclaw",
    auth: [
      {
        methodId: "api-key",
        label: "HexaClaw API key",
        hint: "API key",
        optionKey: "hexaclawApiKey",
        flagName: "--hexaclaw-api-key",
        envVar: "HEXACLAW_API_KEY",
        promptMessage: "Enter HexaClaw API key",
        defaultModel: HEXACLAW_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyHexaclawConfig(cfg),
        wizard: {
          choiceId: "hexaclaw-api-key",
          choiceLabel: "HexaClaw API key",
          groupId: "hexaclaw",
          groupLabel: "HexaClaw",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildHexaclawProvider,
    },
  },
});
