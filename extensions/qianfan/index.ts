import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyQianfanConfig, QIANFAN_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildQianfanProvider } from "./provider-catalog.js";

const PROVIDER_ID = "qianfan";

function isQianfanCodeModel(modelId?: string | null): boolean {
  return (modelId ?? "").toLowerCase().includes("qianfan-code");
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Qianfan Provider",
  description: "Bundled Qianfan provider plugin",
  provider: {
    label: "Qianfan",
    docsPath: "/providers/qianfan",
    auth: [
      {
        methodId: "api-key",
        label: "Qianfan API key",
        hint: "API key",
        optionKey: "qianfanApiKey",
        flagName: "--qianfan-api-key",
        envVar: "QIANFAN_API_KEY",
        promptMessage: "Enter Qianfan API key",
        defaultModel: QIANFAN_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyQianfanConfig(cfg),
      },
    ],
    catalog: {
      buildProvider: buildQianfanProvider,
    },
    buildReplayPolicy: ({ modelId }) =>
      isQianfanCodeModel(modelId) ? { dropThinkingBlocks: true } : undefined,
  },
});
