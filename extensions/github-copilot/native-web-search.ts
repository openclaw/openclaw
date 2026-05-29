import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";

/**
 * Native web search for GitHub Copilot GPT models.
 *
 * Copilot's GPT models use the OpenAI Responses API and support the same
 * native `web_search` tool as OpenAI direct. When enabled, this injects the
 * tool into the request payload so the model can perform server-side web
 * searches without a separate managed search provider or API key.
 *
 * Only activates for models using api: "openai-responses" on the
 * github-copilot provider. Claude and Gemini models on Copilot use different
 * APIs and are unaffected.
 */

const COPILOT_WEB_SEARCH_TOOL = { type: "web_search" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Known model ID prefixes that support native web search on Copilot.
 * Only OpenAI-family models (GPT, o-series) accept the native {type: "web_search"} tool.
 * Gemini and other non-OpenAI models routed through Copilot's openai-responses API
 * do NOT support this tool shape.
 */
const COPILOT_NATIVE_WEB_SEARCH_MODEL_PREFIXES = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];
const COPILOT_NATIVE_WEB_SEARCH_EXACT_MODELS = new Set(["o1", "o3", "o4"]);

function isCopilotNativeWebSearchEligibleModel(model: {
  api?: unknown;
  provider?: unknown;
  id?: unknown;
}): boolean {
  if (model.api !== "openai-responses") {
    return false;
  }
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  if (provider !== "github-copilot") {
    return false;
  }
  const modelId = typeof model.id === "string" ? model.id.toLowerCase() : "";
  return (
    COPILOT_NATIVE_WEB_SEARCH_EXACT_MODELS.has(modelId) ||
    COPILOT_NATIVE_WEB_SEARCH_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix))
  );
}

/**
 * Check if the configured web search provider is compatible with native web search.
 * "openai" here means the OpenAI Responses API native web_search tool shape,
 * including Copilot GPT models that proxy Responses-compatible payloads.
 */
function shouldUseNativeWebSearchProvider(config: OpenClawConfig | undefined): boolean {
  const provider = config?.tools?.web?.search?.provider;
  if (typeof provider !== "string") {
    return true;
  }
  const normalized = provider.trim().toLowerCase();
  return normalized === "" || normalized === "auto" || normalized === "openai";
}

function shouldEnableCopilotNativeWebSearch(params: {
  config?: OpenClawConfig;
  model: { api?: unknown; provider?: unknown; id?: unknown };
}): boolean {
  return (
    params.config?.tools?.web?.search?.enabled !== false &&
    shouldUseNativeWebSearchProvider(params.config) &&
    isCopilotNativeWebSearchEligibleModel(params.model)
  );
}

function isNativeWebSearchTool(tool: unknown): boolean {
  return isRecord(tool) && tool.type === COPILOT_WEB_SEARCH_TOOL.type;
}

function isManagedWebSearchTool(tool: unknown): boolean {
  return isRecord(tool) && tool.type === "function" && tool.name === COPILOT_WEB_SEARCH_TOOL.type;
}

function raiseMinimalReasoningForNativeWebSearch(payload: Record<string, unknown>): void {
  const reasoning = payload.reasoning;
  if (!isRecord(reasoning) || reasoning.effort !== "minimal") {
    return;
  }
  reasoning.effort = "low";
}

export type CopilotNativeWebSearchPatchResult =
  | "payload_not_object"
  | "native_tool_already_present"
  | "injected";

export function patchCopilotNativeWebSearchPayload(
  payload: unknown,
): CopilotNativeWebSearchPatchResult {
  if (!isRecord(payload)) {
    return "payload_not_object";
  }

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const filteredTools = existingTools.filter((tool) => !isManagedWebSearchTool(tool));
  if (filteredTools.some(isNativeWebSearchTool)) {
    if (filteredTools.length !== existingTools.length) {
      payload.tools = filteredTools;
    }
    raiseMinimalReasoningForNativeWebSearch(payload);
    return "native_tool_already_present";
  }

  payload.tools = [...filteredTools, COPILOT_WEB_SEARCH_TOOL];
  raiseMinimalReasoningForNativeWebSearch(payload);
  return "injected";
}

export function createCopilotNativeWebSearchWrapper(
  baseStreamFn: StreamFn,
  params: { config?: OpenClawConfig },
): StreamFn {
  return (model, context, options) => {
    if (!shouldEnableCopilotNativeWebSearch({ config: params.config, model })) {
      return baseStreamFn(model, context, options);
    }
    return streamWithPayloadPatch(baseStreamFn, model, context, options, (payload) => {
      patchCopilotNativeWebSearchPayload(payload);
    });
  };
}
