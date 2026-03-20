import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyZenmuxConfig, ZENMUX_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildZenmuxProvider } from "./provider-catalog.js";

const PROVIDER_ID = "zenmux";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "ZenMux Provider",
  description: "Bundled ZenMux provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ZenMux",
      envVars: ["ZENMUX_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "ZenMux API key",
          hint: "API key",
          optionKey: "zenmuxApiKey",
          flagName: "--zenmux-api-key",
          envVar: "ZENMUX_API_KEY",
          promptMessage: "Enter ZenMux API key",
          defaultModel: ZENMUX_DEFAULT_MODEL_REF,
          expectedProviders: ["zenmux"],
          applyConfig: (cfg) => applyZenmuxConfig(cfg),
          wizard: {
            choiceId: "zenmux-api-key",
            choiceLabel: "ZenMux API key",
            groupId: "zenmux",
            groupLabel: "ZenMux",
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
            buildProvider: buildZenmuxProvider,
          }),
      },
    });
  },
});
