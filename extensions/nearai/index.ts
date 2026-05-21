import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  type ModelCompatConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { applyNearAIModelCompat } from "./models.js";
import { applyNearAIConfig, NEARAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildNearAIProvider, buildStaticNearAIProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nearai";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NEAR AI Provider",
  description: "Bundled NEAR AI Cloud provider plugin",
  provider: {
    label: "NEAR AI Cloud",
    docsPath: "/providers/nearai",
    auth: [
      {
        methodId: "api-key",
        label: "NEAR AI API key",
        hint: "TEE-backed OpenAI-compatible inference",
        optionKey: "nearaiApiKey",
        flagName: "--nearai-api-key",
        envVar: "NEARAI_API_KEY",
        promptMessage: "Enter NEAR AI API key",
        defaultModel: NEARAI_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyNearAIConfig(cfg),
        noteMessage: [
          "NEAR AI Cloud provides OpenAI-compatible inference with TEE-backed models.",
          "Get your API key at: https://cloud.near.ai",
        ].join("\n"),
        noteTitle: "NEAR AI Cloud",
        wizard: {
          groupLabel: "NEAR AI Cloud",
          groupHint: "TEE-backed OpenAI-compatible inference",
        },
      },
    ],
    catalog: {
      buildProvider: buildNearAIProvider,
      buildStaticProvider: buildStaticNearAIProvider,
    },
    normalizeResolvedModel: ({ model }) => {
      const normalized = applyNearAIModelCompat(
        model as typeof model & { compat?: ModelCompatConfig },
      );
      return normalized === model ? undefined : normalized;
    },
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
    }),
  },
});
