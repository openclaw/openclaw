import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyErnieConfig, ERNIE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildErnieProvider } from "./provider-catalog.js";

const PROVIDER_ID = "ernie";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "ERNIE Provider",
  description: "Bundled ERNIE provider plugin",
  provider: {
    label: "ERNIE",
    docsPath: "/providers/ernie",
    auth: [
      {
        methodId: "api-key",
        label: "ERNIE API key (Baidu Wenxin)",
        hint: "Qianfan API for ERNIE models",
        optionKey: "ernieApiKey",
        flagName: "--ernie-api-key",
        envVar: "ERNIE_API_KEY",
        promptMessage: "Enter ERNIE API key",
        defaultModel: ERNIE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyErnieConfig(cfg),
        wizard: {
          choiceId: "ernie-api-key",
          choiceLabel: "ERNIE API key (Baidu Wenxin)",
          groupId: "ernie",
          groupLabel: "ERNIE",
          groupHint: "Qianfan API for ERNIE models",
        },
      },
    ],
    catalog: {
      buildProvider: buildErnieProvider,
    },
  },
});
