import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyZenmuxConfig, ZENMUX_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildZenmuxProvider } from "./provider-catalog.js";

const PROVIDER_ID = "zenmux";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "ZenMux Provider",
  description: "Bundled ZenMux provider plugin",
  provider: {
    label: "ZenMux",
    docsPath: "/providers/zenmux",
    auth: [
      {
        methodId: "api-key",
        label: "ZenMux API key",
        hint: "API key",
        optionKey: "zenmuxApiKey",
        flagName: "--zenmux-api-key",
        envVar: "ZENMUX_API_KEY",
        promptMessage: "Enter ZenMux API key",
        defaultModel: ZENMUX_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyZenmuxConfig(cfg),
        wizard: {
          choiceId: "zenmux-api-key",
          choiceLabel: "ZenMux API key",
          groupId: "zenmux",
          groupLabel: "ZenMux",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildZenmuxProvider,
    },
  },
});
