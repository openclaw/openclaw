/**
 * AIOnly provider plugin entrypoint.
 */
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { applyAIOnlyConfig, AIONLY_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildAIOnlyProvider } from "./provider-catalog.js";

const PROVIDER_ID = "aionly";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "AIOnly Provider",
  description: "Bundled AIOnly provider plugin",
  provider: {
    label: "AIOnly",
    docsPath: "/providers/aionly",
    auth: [
      {
        methodId: "api-key",
        label: "AIOnly API key",
        hint: "AIOnly OpenAI-compatible API key",
        optionKey: "aionlyApiKey",
        flagName: "--aionly-api-key",
        envVar: "AIONLY_API_KEY",
        promptMessage: "Enter AIOnly API key",
        defaultModel: AIONLY_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyAIOnlyConfig(cfg),
        noteMessage: [
          "AIOnly provides high-performance OpenAI-compatible inference.",
          "Get your API key at: https://api.aionly.com",
        ].join("\n"),
        noteTitle: "AIOnly",
        wizard: {
          groupLabel: "AIOnly",
          groupHint: "OpenAI-compatible inference",
        },
      },
    ],
    catalog: {
      buildProvider: buildAIOnlyProvider,
      buildStaticProvider: buildAIOnlyProvider,
    },
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});
