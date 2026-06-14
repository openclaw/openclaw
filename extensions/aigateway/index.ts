// AIgateway plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { AIGATEWAY_DEFAULT_MODEL_REF } from "./models.js";
import { buildAigatewayProvider } from "./provider-catalog.js";

const PROVIDER_ID = "aigateway";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "AIgateway Provider",
  description: "Bundled AIgateway provider plugin",
  provider: {
    label: "AIgateway",
    docsPath: "/providers/aigateway",
    envVars: ["AIGATEWAY_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "AIgateway API key",
        hint: "OpenAI-compatible AIgateway endpoint",
        optionKey: "aigatewayApiKey",
        flagName: "--aigateway-api-key",
        envVar: "AIGATEWAY_API_KEY",
        promptMessage: "Enter AIgateway API key",
        defaultModel: AIGATEWAY_DEFAULT_MODEL_REF,
        noteTitle: "AIgateway",
        noteMessage: "Manage API keys at https://aigateway.sh/",
      },
    ],
    catalog: {
      buildProvider: buildAigatewayProvider,
      buildStaticProvider: buildAigatewayProvider,
      allowExplicitBaseUrl: true,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});
