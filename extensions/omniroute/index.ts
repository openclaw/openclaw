// OmniRoute plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { applyOmniRouteConfig } from "./onboard.js";
import {
  OMNIROUTE_API_KEY_ENV_VAR,
  OMNIROUTE_DEFAULT_MODEL_REF,
  OMNIROUTE_LABEL,
  OMNIROUTE_PROVIDER_ID,
} from "./models.js";
import { buildOmniRouteProvider } from "./provider-catalog.js";

export default defineSingleProviderPluginEntry({
  id: OMNIROUTE_PROVIDER_ID,
  name: "OmniRoute Provider",
  description: "Bundled OmniRoute provider plugin",
  provider: {
    label: OMNIROUTE_LABEL,
    docsPath: "/providers/omniroute",
    envVars: [OMNIROUTE_API_KEY_ENV_VAR],
    auth: [
      {
        methodId: "api-key",
        label: "OmniRoute API key",
        hint: "OpenAI-compatible OmniRoute gateway",
        optionKey: "omnirouteApiKey",
        flagName: "--omniroute-api-key",
        envVar: OMNIROUTE_API_KEY_ENV_VAR,
        promptMessage: "Enter OmniRoute API key",
        defaultModel: OMNIROUTE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyOmniRouteConfig(cfg),
        noteTitle: "OmniRoute",
        noteMessage: [
          "OmniRoute exposes an OpenAI-compatible /v1/chat/completions endpoint.",
          "By default this plugin targets http://localhost:20128/v1 and lets OmniRoute route downstream providers.",
        ].join("\n"),
        wizard: {
          choiceId: "omniroute-api-key",
          choiceLabel: "OmniRoute API key",
          choiceHint: "OpenAI-compatible OmniRoute gateway",
          groupId: OMNIROUTE_PROVIDER_ID,
          groupLabel: OMNIROUTE_LABEL,
          groupHint: "OpenAI-compatible OmniRoute gateway",
        },
      },
    ],
    catalog: {
      buildProvider: buildOmniRouteProvider,
      buildStaticProvider: buildOmniRouteProvider,
      allowExplicitBaseUrl: true,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: OMNIROUTE_PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
    isModernModelRef: () => true,
  },
});
