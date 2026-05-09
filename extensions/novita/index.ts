import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { NOVITA_DEFAULT_MODEL_REF, applyNovitaConfig } from "./onboard.js";
import { buildNovitaProvider, buildStaticNovitaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "novita";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Novita AI Provider",
  description: "Bundled Novita AI provider plugin",
  provider: {
    label: "Novita AI",
    docsPath: "/providers/novita",
    envVars: ["NOVITA_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "Novita AI API key",
        hint: "OpenAI-compatible model access",
        optionKey: "novitaApiKey",
        flagName: "--novita-api-key",
        envVar: "NOVITA_API_KEY",
        promptMessage: "Enter Novita AI API key",
        defaultModel: NOVITA_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyNovitaConfig(cfg),
        noteTitle: "Novita AI",
        noteMessage: [
          "Novita AI provides OpenAI-compatible access to DeepSeek, Kimi, GLM, MiniMax, and other models.",
          "Get your API key at: https://novita.ai/settings/key-management",
        ].join("\n"),
        wizard: {
          choiceId: "novita-api-key",
          choiceLabel: "Novita AI API key",
          groupId: "novita",
          groupLabel: "Novita AI",
          groupHint: "OpenAI-compatible model access",
        },
      },
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        return {
          provider: {
            ...(await buildNovitaProvider(discoveryApiKey)),
            apiKey,
          },
        };
      },
      staticRun: async () => ({
        provider: buildStaticNovitaProvider(),
      }),
    },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    resolveThinkingProfile: () => ({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
      ],
      defaultLevel: "medium",
    }),
    isModernModelRef: () => true,
  },
});
