/**
 * Meta Model API provider plugin entrypoint.
 */
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { OPENAI_COMPATIBLE_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import { applyMetaModelApiConfig, META_MODEL_API_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildMetaModelApiProvider } from "./provider-catalog.js";
import { wrapMetaModelApiProviderStream } from "./stream.js";
import { resolveMetaModelApiThinkingProfile } from "./thinking.js";

const PROVIDER_ID = "meta-model-api";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Meta Model API Provider",
  description: "Bundled Meta Model API provider plugin",
  provider: {
    label: "Meta Model API",
    docsPath: "/providers/meta-model-api",
    auth: [
      {
        methodId: "api-key",
        label: "Meta Model API key",
        hint: "Meta Model API (Responses API)",
        optionKey: "metaModelApiKey",
        flagName: "--meta-model-api-key",
        envVar: "MODEL_API_KEY",
        promptMessage: "Enter Meta Model API key",
        defaultModel: META_MODEL_API_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMetaModelApiConfig(cfg),
        noteMessage: ["Meta Model API provides Responses API inference."].join("\n"),
        noteTitle: "Meta Model API",
        wizard: {
          groupLabel: "Meta Model API",
          groupHint: "Meta Model API (Responses API)",
        },
      },
    ],
    catalog: {
      buildProvider: buildMetaModelApiProvider,
      buildStaticProvider: buildMetaModelApiProvider,
    },
    ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
    wrapStreamFn: wrapMetaModelApiProviderStream,
    resolveThinkingProfile: ({ modelId }) => resolveMetaModelApiThinkingProfile(modelId),
  },
});
