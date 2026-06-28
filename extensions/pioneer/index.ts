// Pioneer plugin entrypoint registers its OpenClaw integration.
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { PIONEER_DEFAULT_MODEL_REF } from "./models.js";
import { applyPioneerConfig } from "./onboard.js";
import { buildPioneerCatalogResult, buildPioneerProvider } from "./provider-catalog.js";

const PROVIDER_ID = "pioneer";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Pioneer Provider",
  description: "Bundled Pioneer provider plugin",
  provider: {
    label: "Pioneer",
    docsPath: "/providers/pioneer",
    envVars: ["PIONEER_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "Pioneer API key",
        hint: "OpenAI-compatible Pioneer endpoint",
        optionKey: "pioneerApiKey",
        flagName: "--pioneer-api-key",
        envVar: "PIONEER_API_KEY",
        promptMessage: "Enter Pioneer API key",
        defaultModel: PIONEER_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyPioneerConfig(cfg),
        wizard: {
          choiceId: "pioneer-api-key",
          choiceLabel: "Pioneer API key",
          groupId: "pioneer",
          groupLabel: "Pioneer",
          groupHint: "OpenAI-compatible Pioneer endpoint",
          onboardingScopes: ["text-inference"],
        },
      },
    ],
    catalog: {
      order: "simple",
      run: buildPioneerCatalogResult,
      staticRun: async () => ({
        provider: buildPioneerProvider(),
      }),
    },
    normalizeResolvedModel: ({ model }) => {
      // Pioneer API requires the "pioneer/" prefix for routing aliases like "auto".
      // model.id is the bare catalog id; rewrite it so the transport sends "pioneer/auto".
      if (model.id.toLowerCase() === "auto") {
        return { ...model, id: `pioneer/${model.id}` };
      }
      return undefined;
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    matchesContextOverflowError: ({ errorMessage }) =>
      /\bpioneer\b.*(?:input.*too long|context.*exceed|context.*length)/i.test(errorMessage),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});
