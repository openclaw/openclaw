import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyQianfanConfig, QIANFAN_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildQianfanProvider } from "./provider-catalog.js";

const PROVIDER_ID = "qianfan";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Qianfan Provider",
  description: "Bundled Qianfan provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Qianfan",
      docsPath: "/providers/qianfan",
      envVars: ["QIANFAN_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Qianfan API key",
          hint: "API key",
          optionKey: "qianfanApiKey",
          flagName: "--qianfan-api-key",
          envVar: "QIANFAN_API_KEY",
          promptMessage: "Enter Qianfan API key",
          defaultModel: QIANFAN_DEFAULT_MODEL_REF,
          expectedProviders: ["qianfan"],
          applyConfig: (cfg) => applyQianfanConfig(cfg),
          wizard: {
            choiceId: "qianfan-api-key",
            choiceLabel: "Qianfan API key",
            groupId: "qianfan",
            groupLabel: "Qianfan",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildQianfanProvider,
          }),
      },
    });
  },
});
