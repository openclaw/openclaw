import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  readConfiguredProviderCatalogEntries,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { OPENAI_COMPATIBLE_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import { applyWaveSpeedConfig } from "./onboard.js";
import { WAVESPEED_DEFAULT_MODEL_REF } from "./models.js";
import { buildWaveSpeedProvider } from "./provider-catalog.js";

const PROVIDER_ID = "wavespeed";

function buildWaveSpeedAuthMethods() {
  return [
    createProviderApiKeyAuthMethod({
      providerId: PROVIDER_ID,
      methodId: "wavespeed-platform",
      label: "WaveSpeed API key",
      hint: "Direct access to WaveSpeed LLM",
      optionKey: "wavespeedApiKey",
      flagName: "--wavespeed-api-key",
      envVar: "WAVESPEED_API_KEY",
      promptMessage: "Enter WaveSpeed API key",
      defaultModel: WAVESPEED_DEFAULT_MODEL_REF,
      expectedProviders: [PROVIDER_ID],
      applyConfig: (cfg) => applyWaveSpeedConfig(cfg),
      wizard: {
        choiceId: "wavespeed-api-key",
        choiceLabel: "WaveSpeed API key",
        choiceHint: "Direct (llm.wavespeed.ai)",
        groupId: "wavespeed",
        groupLabel: "WaveSpeed",
        groupHint: "OpenAI-compatible LLM access",
      },
    }),
  ];
}

async function resolveWaveSpeedCatalog(ctx: ProviderCatalogContext) {
  const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
  if (!apiKey) {
    return null;
  }
  return { provider: { ...buildWaveSpeedProvider(), apiKey } };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "WaveSpeed Provider",
  description: "Bundled WaveSpeed provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "WaveSpeed",
      docsPath: "/providers/wavespeed",
      envVars: ["WAVESPEED_API_KEY"],
      auth: buildWaveSpeedAuthMethods(),
      catalog: {
        run: resolveWaveSpeedCatalog,
      },
      augmentModelCatalog: ({ config }) =>
        readConfiguredProviderCatalogEntries({
          config,
          providerId: PROVIDER_ID,
        }),
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    });
  },
});
