// Openai plugin module implements native web search behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isOpenAIApiBaseUrl } from "./base-url.js";

const OPENAI_WEB_SEARCH_TOOL_TYPE = "web_search";

type OpenAINativeWebSearchRequest = {
  searchContextSize?: "low" | "medium" | "high";
  userLocation?: {
    type: "approximate";
    city?: string;
    country?: string;
    region?: string;
    timezone?: string;
  } | null;
};

type OpenAINativeWebSearchPatchResult =
  | "payload_not_object"
  | "native_tool_already_present"
  | "injected";

function isOpenAINativeWebSearchEligibleModel(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  const provider = typeof model.provider === "string" ? model.provider : undefined;
  if (model.api !== "openai-responses" || !provider || normalizeProviderId(provider) !== "openai") {
    return false;
  }
  const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl : undefined;
  return !baseUrl || isOpenAIApiBaseUrl(baseUrl);
}

function isCodexNativeWebSearchEligibleModel(model: { api?: unknown }): boolean {
  return model.api === "openai-chatgpt-responses";
}

function shouldUseOpenAINativeWebSearchProvider(config: OpenClawConfig | undefined): boolean {
  const provider = config?.tools?.web?.search?.provider;
  if (typeof provider !== "string") {
    return true;
  }
  const normalized = provider.trim().toLowerCase();
  return normalized === "" || normalized === "auto" || normalized === "openai";
}

function shouldEnableOpenAINativeWebSearch(params: {
  config?: OpenClawConfig;
  model: { api?: unknown; provider?: unknown; baseUrl?: unknown };
}): boolean {
  return (
    params.config?.tools?.web?.search?.enabled !== false &&
    shouldUseOpenAINativeWebSearchProvider(params.config) &&
    isOpenAINativeWebSearchEligibleModel(params.model)
  );
}

function explainOpenAINativeWebSearchDisabled(params: {
  config?: OpenClawConfig;
  model: { api?: unknown; provider?: unknown; baseUrl?: unknown };
  nativeWebSearchAllowedByToolPolicy?: boolean;
}): string {
  if (params.config?.tools?.web?.search?.enabled === false) {
    return "web search is disabled";
  }
  if (!shouldUseOpenAINativeWebSearchProvider(params.config)) {
    return "tools.web.search.provider is not auto or openai";
  }
  if (!isOpenAINativeWebSearchEligibleModel(params.model)) {
    return "the selected model is not a direct OpenAI Responses model";
  }
  if (params.nativeWebSearchAllowedByToolPolicy === false) {
    return "tool policy denies web_search";
  }
  return "native OpenAI web_search is unavailable";
}

function isNativeWebSearchTool(tool: unknown): tool is Record<string, unknown> {
  return isRecord(tool) && tool.type === OPENAI_WEB_SEARCH_TOOL_TYPE;
}

function isManagedWebSearchTool(tool: unknown): boolean {
  return isRecord(tool) && tool.type === "function" && tool.name === OPENAI_WEB_SEARCH_TOOL_TYPE;
}

function raiseMinimalReasoningForOpenAINativeWebSearch(payload: Record<string, unknown>): void {
  const reasoning = payload.reasoning;
  if (!isRecord(reasoning) || reasoning.effort !== "minimal") {
    return;
  }
  reasoning.effort = "low";
}

function buildOpenAIWebSearchTool(
  nativeWebSearch?: OpenAINativeWebSearchRequest,
): Record<string, unknown> {
  return {
    type: OPENAI_WEB_SEARCH_TOOL_TYPE,
    ...(nativeWebSearch?.searchContextSize
      ? { search_context_size: nativeWebSearch.searchContextSize }
      : {}),
    ...(nativeWebSearch?.userLocation ? { user_location: nativeWebSearch.userLocation } : {}),
  };
}

function applyOpenAIWebSearchOptions(
  tool: Record<string, unknown>,
  nativeWebSearch: OpenAINativeWebSearchRequest | undefined,
): void {
  if (!nativeWebSearch) {
    return;
  }
  if (nativeWebSearch.searchContextSize) {
    tool.search_context_size = nativeWebSearch.searchContextSize;
  }
  if (nativeWebSearch.userLocation === null) {
    delete tool.user_location;
  } else if (nativeWebSearch.userLocation) {
    tool.user_location = nativeWebSearch.userLocation;
  }
}

export function resolveOpenAINativeWebSearchRequest(
  extraParams: Record<string, unknown> | undefined,
): OpenAINativeWebSearchRequest | undefined {
  const value = extraParams?.nativeWebSearch;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("nativeWebSearch must be an object");
  }
  return value as OpenAINativeWebSearchRequest;
}

export function patchOpenAINativeWebSearchPayload(
  payload: unknown,
  nativeWebSearch?: OpenAINativeWebSearchRequest,
): OpenAINativeWebSearchPatchResult {
  if (!isRecord(payload)) {
    return "payload_not_object";
  }

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const filteredTools = existingTools.filter((tool) => !isManagedWebSearchTool(tool));
  const existingNativeTool = filteredTools.find(isNativeWebSearchTool);
  if (existingNativeTool) {
    applyOpenAIWebSearchOptions(existingNativeTool, nativeWebSearch);
    if (filteredTools.length !== existingTools.length) {
      payload.tools = filteredTools;
    }
    raiseMinimalReasoningForOpenAINativeWebSearch(payload);
    return "native_tool_already_present";
  }

  payload.tools = [...filteredTools, buildOpenAIWebSearchTool(nativeWebSearch)];
  raiseMinimalReasoningForOpenAINativeWebSearch(payload);
  return "injected";
}

export function createOpenAINativeWebSearchWrapper(
  baseStreamFn: StreamFn | undefined,
  params: {
    config?: OpenClawConfig;
    agentId?: string;
    nativeWebSearchAllowedByToolPolicy?: boolean;
    nativeWebSearch?: OpenAINativeWebSearchRequest;
  },
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldEnableOpenAINativeWebSearch({ config: params.config, model })) {
      if (params.nativeWebSearch && !isCodexNativeWebSearchEligibleModel(model)) {
        throw new Error(
          `web_search_options require native OpenAI web_search, but ${explainOpenAINativeWebSearchDisabled(
            {
              config: params.config,
              model,
              nativeWebSearchAllowedByToolPolicy: params.nativeWebSearchAllowedByToolPolicy,
            },
          )}`,
        );
      }
      return underlying(model, context, options);
    }
    if (params.nativeWebSearchAllowedByToolPolicy === false) {
      if (params.nativeWebSearch) {
        throw new Error(
          `web_search_options require native OpenAI web_search, but ${explainOpenAINativeWebSearchDisabled(
            {
              config: params.config,
              model,
              nativeWebSearchAllowedByToolPolicy: params.nativeWebSearchAllowedByToolPolicy,
            },
          )}`,
        );
      }
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      patchOpenAINativeWebSearchPayload(payload, params.nativeWebSearch);
    });
  };
}
