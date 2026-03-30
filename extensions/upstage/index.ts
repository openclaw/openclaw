import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyUpstageConfig, UPSTAGE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildUpstageProvider } from "./provider-catalog.js";
import { createUpstagePayloadCompatibilityWrapper, prepareUpstageExtraParams } from "./stream.js";

const PROVIDER_ID = "upstage";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Upstage Provider",
  description: "Bundled Upstage provider plugin",
  provider: {
    label: "Upstage",
    docsPath: "/providers/models",
    auth: [
      {
        methodId: "api-key",
        label: "Upstage API key",
        hint: "Solar chat models",
        optionKey: "upstageApiKey",
        flagName: "--upstage-api-key",
        envVar: "UPSTAGE_API_KEY",
        promptMessage: "Enter Upstage API key",
        defaultModel: UPSTAGE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyUpstageConfig(cfg),
        noteMessage: [
          "Upstage Chat API uses the OpenAI-compatible endpoint:",
          "https://api.upstage.ai/v1",
          "Reference: https://console.upstage.ai/api/chat",
        ].join("\n"),
        noteTitle: "Upstage Chat API",
        wizard: {
          choiceId: "upstage-api-key",
          choiceLabel: "Upstage API key",
          groupId: "upstage",
          groupLabel: "Upstage",
          groupHint: "API key",
        },
      },
    ],
    catalog: {
      buildProvider: buildUpstageProvider,
    },
    prepareExtraParams: (ctx) => prepareUpstageExtraParams(ctx.extraParams),
    wrapStreamFn: (ctx) => createUpstagePayloadCompatibilityWrapper(ctx.streamFn),
  },
});
