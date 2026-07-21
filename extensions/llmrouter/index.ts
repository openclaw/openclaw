// Llmrouter plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { LLMROUTER_DEFAULT_MODEL_REF, resolveLlmrouterDynamicModel } from "./models.js";
import { applyLlmrouterConfig } from "./onboard.js";
import { buildLlmrouterProvider } from "./provider-catalog.js";

const PROVIDER_ID = "llmrouter";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "LLMRouter Provider",
  description: "Official LLMRouter provider plugin",
  provider: {
    label: "LLMRouter",
    docsPath: "/providers/llmrouter",
    auth: [
      {
        methodId: "api-key",
        label: "LLMRouter API key",
        hint: "Cost-aware auto model routing",
        optionKey: "llmrouterApiKey",
        flagName: "--llmrouter-api-key",
        envVar: "LLMROUTER_API_KEY",
        promptMessage: "Enter LLMRouter API key",
        defaultModel: LLMROUTER_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyLlmrouterConfig(cfg),
        noteTitle: "LLMRouter",
        noteMessage: [
          "LLMRouter routes every request to the cheapest model that meets the query's needs.",
          "Get your API key at: https://llmrouter.sh/keys",
        ].join("\n"),
        wizard: {
          groupLabel: "LLMRouter",
          groupHint: "Cost-aware auto model routing",
        },
      },
    ],
    catalog: {
      buildProvider: buildLlmrouterProvider,
    },
    resolveDynamicModel: ({ modelId }) => resolveLlmrouterDynamicModel(modelId),
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    isModernModelRef: () => true,
  },
});
