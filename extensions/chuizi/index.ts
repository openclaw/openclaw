import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyChuiziConfig, CHUIZI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildChuiziProvider } from "./provider-catalog.js";

const PROVIDER_ID = "chuizi";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Chuizi Provider",
  description: "Bundled Chuizi.AI provider plugin",
  provider: {
    label: "Chuizi.AI",
    docsPath: "/providers/chuizi",
    auth: [
      {
        methodId: "api-key",
        label: "Chuizi.AI API key",
        hint: "API key",
        optionKey: "chuiziApiKey",
        flagName: "--chuizi-api-key",
        envVar: "CHUIZI_API_KEY",
        promptMessage: "Enter Chuizi.AI API key",
        defaultModel: CHUIZI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyChuiziConfig(cfg),
        wizard: {
          choiceId: "chuizi-api-key",
          choiceLabel: "Chuizi.AI API key",
          groupId: "chuizi",
          groupLabel: "Chuizi.AI",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildChuiziProvider,
    },
  },
});
