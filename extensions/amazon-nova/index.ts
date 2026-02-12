import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyAmazonNovaConfig, AMAZON_NOVA_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildAmazonNovaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "amazon-nova";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Amazon Nova Provider",
  description: "Bundled Amazon Nova provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Amazon Nova",
      docsPath: "/providers/amazon-nova",
      envVars: ["NOVA_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Amazon Nova API key",
          hint: "API key",
          optionKey: "novaApiKey",
          flagName: "--nova-api-key",
          envVar: "NOVA_API_KEY",
          promptMessage: "Enter Amazon Nova API key",
          defaultModel: AMAZON_NOVA_DEFAULT_MODEL_REF,
          expectedProviders: ["amazon-nova"],
          applyConfig: (cfg) => applyAmazonNovaConfig(cfg),
          wizard: {
            choiceId: "amazon-nova-api-key",
            choiceLabel: "Amazon Nova API key",
            groupId: "amazon-nova",
            groupLabel: "Amazon Nova",
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
            buildProvider: buildAmazonNovaProvider,
          }),
      },
    });
  },
});
