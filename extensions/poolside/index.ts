/** Poolside provider plugin entrypoint. */
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { POOLSIDE_DEFAULT_MODEL_REF, resolvePoolsideDynamicModel } from "./models.js";
import { applyPoolsideConfig } from "./onboard.js";
import { buildPoolsideProvider } from "./provider-catalog.js";
import { createPoolsideSamplingWrapper } from "./stream.js";

const PROVIDER_ID = "poolside";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Poolside Provider",
  description: "Official Poolside Laguna model provider plugin",
  provider: {
    label: "Poolside",
    docsPath: "/providers/poolside",
    auth: [
      {
        methodId: "api-key",
        label: "Poolside API key",
        hint: "Laguna model family",
        optionKey: "poolsideApiKey",
        flagName: "--poolside-api-key",
        envVar: "POOLSIDE_API_KEY",
        promptMessage: "Enter Poolside API key",
        defaultModel: POOLSIDE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyPoolsideConfig(cfg),
        noteTitle: "Poolside",
        noteMessage: [
          "Poolside serves the Laguna model family behind one OpenAI-compatible API.",
          "Learn more at: https://poolside.ai",
        ].join("\n"),
        wizard: {
          groupLabel: "Poolside",
          groupHint: "Laguna model family",
        },
      },
    ],
    catalog: {
      buildProvider: buildPoolsideProvider,
      buildStaticProvider: buildPoolsideProvider,
      allowExplicitBaseUrl: true,
    },
    resolveDynamicModel: ({ modelId }) => resolvePoolsideDynamicModel(modelId),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    wrapStreamFn: (ctx) => createPoolsideSamplingWrapper(ctx),
    isModernModelRef: () => true,
  },
});
