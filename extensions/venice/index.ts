import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyVeniceConfig, VENICE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildVeniceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "venice";

const venicePlugin = {
  id: PROVIDER_ID,
  name: "Venice Provider",
  description: "Bundled Venice provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Venice",
      docsPath: "/providers/venice",
      envVars: ["VENICE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Venice AI API key",
          hint: "Privacy-focused (uncensored models)",
          optionKey: "veniceApiKey",
          flagName: "--venice-api-key",
          envVar: "VENICE_API_KEY",
          promptMessage: "Enter Venice AI API key",
          defaultModel: VENICE_DEFAULT_MODEL_REF,
          expectedProviders: ["venice"],
          applyConfig: (cfg) => applyVeniceConfig(cfg),
          noteMessage: [
            "Venice AI provides privacy-focused inference with uncensored models.",
            "Get your API key at: https://venice.ai/settings/api",
            "Supports 'private' (fully private) and 'anonymized' (proxy) modes.",
          ].join("\n"),
          noteTitle: "Venice AI",
          wizard: {
            choiceId: "venice-api-key",
            choiceLabel: "Venice AI API key",
            groupId: "venice",
            groupLabel: "Venice AI",
            groupHint: "Privacy-focused (uncensored models)",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildVeniceProvider,
          }),
      },
    });
  },
};

export default venicePlugin;
