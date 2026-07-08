// TokenLab plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { TOKENLAB_DEFAULT_MODEL_REF } from "./models.js";
import { applyTokenLabConfig } from "./onboard.js";
import { buildTokenLabProvider } from "./provider-catalog.js";

const PROVIDER_ID = "tokenlab";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "TokenLab Provider",
  description: "Bundled TokenLab provider plugin",
  provider: {
    label: "TokenLab",
    docsPath: "/providers/tokenlab",
    envVars: ["TOKENLAB_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "TokenLab API key",
        hint: "OpenAI-compatible chat plus native Responses, Anthropic Messages, and Gemini formats",
        optionKey: "tokenlabApiKey",
        flagName: "--tokenlab-api-key",
        envVar: "TOKENLAB_API_KEY",
        promptMessage: "Enter TokenLab API key",
        defaultModel: TOKENLAB_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyTokenLabConfig(cfg),
        noteTitle: "TokenLab",
        noteMessage: [
          "Manage API keys at https://tokenlab.sh",
          "OpenClaw uses TokenLab's OpenAI-compatible chat route.",
          "TokenLab also exposes native /v1/responses, Anthropic Messages, and Gemini generateContent formats for clients that support them.",
        ].join("\n"),
        wizard: {
          choiceId: "tokenlab-api-key",
          choiceLabel: "TokenLab API key",
          groupId: PROVIDER_ID,
          groupLabel: "TokenLab",
          groupHint: "Multi-provider AI gateway",
        },
      },
    ],
    catalog: {
      buildProvider: buildTokenLabProvider,
      buildStaticProvider: buildTokenLabProvider,
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
