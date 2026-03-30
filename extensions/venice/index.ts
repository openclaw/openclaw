import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyModelCompatPatch } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { XAI_UNSUPPORTED_SCHEMA_KEYWORDS } from "openclaw/plugin-sdk/provider-tools";
import { applyVeniceConfig, VENICE_DEFAULT_MODEL_REF } from "./onboard.js";
import { VENICE_MODEL_CATALOG } from "./models.js";
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
    prepareExtraParams: ({ modelId, extraParams, thinkingLevel }) => {
      // Check if this is a reasoning model via thinkingLevel hint or catalog metadata
      // Only apply strip_thinking_response when thinking is actually enabled (not 'off')
      const thinkingEnabled = thinkingLevel != null && thinkingLevel !== 'off';
      const isCatalogReasoningModel = isVeniceReasoningModelFromCatalog(modelId);
      const isReasoningModel = thinkingEnabled || isCatalogReasoningModel;
      
      if (!isReasoningModel) {
        return extraParams;
      }
      
      // For reasoning models, add Venice-specific parameters to strip thinking response
      // This moves the answer from reasoning_content back into content
      return {
        ...extraParams,
        venice_parameters: {
          ...extraParams?.venice_parameters,
          strip_thinking_response: true,
          // Only set disable_thinking as default if user didn't provide a value
          disable_thinking: extraParams?.venice_parameters?.disable_thinking ?? false,
        },
      };
    },
  },
});

/**
 * Check if a Venice model ID corresponds to a reasoning model using catalog metadata.
 * This is more reliable than string matching since it uses the official catalog flags.
 */
function isVeniceReasoningModelFromCatalog(modelId: string): boolean {
  const catalogModel = VENICE_MODEL_CATALOG.find(m => m.id === modelId);
  return catalogModel?.reasoning === true;
}

/**
 * Fallback: Check if a Venice model ID corresponds to a reasoning model via name patterns.
 * Used for dynamic models not yet in the static catalog.
 */
function isVeniceReasoningModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return (
    lower.includes("thinking") ||
    lower.includes("minimax") ||
    lower.includes("kimi-k2") ||
    lower.includes("glm-4.7") ||
    lower.includes("glm-5") ||
    lower.includes("deepseek") ||
    lower.includes("qwen3-235b-a22b-thinking") ||
    lower.includes("qwen3-5-35b-a3b") ||
    lower.includes("qwen3-4b") ||
    lower.includes("claude-") ||
    lower.includes("gpt-5") ||
    lower.includes("gemini") ||
    lower.includes("grok")
  );
}
