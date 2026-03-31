import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyModelCompatPatch } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { XAI_UNSUPPORTED_SCHEMA_KEYWORDS } from "openclaw/plugin-sdk/provider-tools";
import { applyVeniceConfig, VENICE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildVeniceProvider } from "./provider-catalog.js";

const PROVIDER_ID = "venice";
const XAI_TOOL_SCHEMA_PROFILE = "xai";
const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";

function isXaiBackedVeniceModel(modelId: string): boolean {
  return modelId.trim().toLowerCase().includes("grok");
}

function resolveXaiCompatPatch(): ModelCompatConfig {
  return {
    toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
    unsupportedToolSchemaKeywords: Array.from(XAI_UNSUPPORTED_SCHEMA_KEYWORDS),
    nativeWebSearchTool: true,
    toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  };
}

function applyXaiCompat<T extends { compat?: unknown }>(model: T): T {
  return applyModelCompatPatch(
    model as T & { compat?: ModelCompatConfig },
    resolveXaiCompatPatch(),
  ) as T;
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Venice Provider",
  description: "Bundled Venice provider plugin",
  provider: {
    label: "Venice",
    docsPath: "/providers/venice",
    auth: [
      {
        methodId: "api-key",
        label: "Venice AI API key",
        hint: "Privacy-focused (uncensored models)",
        optionKey: "veniceApiKey",
        flagName: "--venice-api-key",
        envVar: "VENICE_API_KEY",
        promptMessage: "Enter Venice AI API key",
        defaultModel: VENICE_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyVeniceConfig(cfg),
        noteMessage: [
          "Venice AI provides privacy-focused inference with uncensored models.",
          "Get your API key at: https://venice.ai/settings/api",
          "Supports 'private' (fully private) and 'anonymized' (proxy) modes.",
        ].join("\n"),
        noteTitle: "Venice AI",
        wizard: {
          groupLabel: "Venice AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildVeniceProvider,
    },
    normalizeResolvedModel: ({ modelId, model }) =>
      isXaiBackedVeniceModel(modelId) ? applyXaiCompat(model) : undefined,
  },
});
