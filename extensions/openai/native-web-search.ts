import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveNativeWebSearch } from "./native-web-search-policy.js";

const OPENAI_WEB_SEARCH_TOOL = { type: "web_search" } as const;

function isNativeWebSearchTool(tool: unknown): boolean {
  return isRecord(tool) && tool.type === OPENAI_WEB_SEARCH_TOOL.type;
}

function isManagedWebSearchTool(tool: unknown): boolean {
  return isRecord(tool) && tool.type === "function" && tool.name === OPENAI_WEB_SEARCH_TOOL.type;
}

function raiseMinimalReasoningForOpenAINativeWebSearch(payload: Record<string, unknown>): void {
  const reasoning = payload.reasoning;
  if (!isRecord(reasoning) || reasoning.effort !== "minimal") {
    return;
  }
  reasoning.effort = "low";
}

function patchOpenAINativeWebSearchPayload(payload: unknown): void {
  if (!isRecord(payload)) {
    return;
  }

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const filteredTools = existingTools.filter((tool) => !isManagedWebSearchTool(tool));
  if (filteredTools.some(isNativeWebSearchTool)) {
    if (filteredTools.length !== existingTools.length) {
      payload.tools = filteredTools;
    }
    raiseMinimalReasoningForOpenAINativeWebSearch(payload);
    return;
  }

  payload.tools = [...filteredTools, OPENAI_WEB_SEARCH_TOOL];
  raiseMinimalReasoningForOpenAINativeWebSearch(payload);
}

export function createOpenAINativeWebSearchWrapper(
  baseStreamFn: StreamFn | undefined,
  params: {
    config?: OpenClawConfig;
    agentId?: string;
    nativeWebSearchAllowedByToolPolicy?: boolean;
  },
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload, options }) => {
      (
        options as { openclawCodeModeAllowedHostedToolTypes?: Set<string> } | undefined
      )?.openclawCodeModeAllowedHostedToolTypes?.add(OPENAI_WEB_SEARCH_TOOL.type);
      patchOpenAINativeWebSearchPayload(payload);
    },
    {
      shouldPatch: ({ model }) =>
        params.nativeWebSearchAllowedByToolPolicy !== false &&
        resolveNativeWebSearch({
          config: params.config,
          provider: model.provider,
          modelId: model.id,
          api: model.api,
          baseUrl: model.baseUrl,
        }),
    },
  );
}
