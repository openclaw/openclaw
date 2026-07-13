// Github Copilot plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildCopilotIdeHeaders, COPILOT_INTEGRATION_ID } from "openclaw/plugin-sdk/provider-auth";
import { hasNativeWebSearchTool } from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rewriteCopilotResponsePayloadConnectionBoundIds } from "./connection-bound-ids.js";
import { stripCopilotAssistantThinkingMessages } from "./replay-policy.js";

type StreamOptions = Parameters<StreamFn>[2];
type CopilotPayloadPatch = (
  payload: Record<string, unknown>,
  model: Parameters<StreamFn>[0],
) => void;
const COPILOT_NATIVE_WEB_SEARCH_TOOL = { type: "web_search" } as const;

function containsCopilotContentType(value: unknown, type: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsCopilotContentType(item, type));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as { type?: unknown; content?: unknown };
  return entry.type === type || containsCopilotContentType(entry.content, type);
}

function inferCopilotInitiator(messages: Context["messages"]): "agent" | "user" {
  const last = messages[messages.length - 1];
  if (!last) {
    return "user";
  }
  if (last.role === "user" && containsCopilotContentType(last.content, "tool_result")) {
    return "agent";
  }
  return last.role === "user" ? "user" : "agent";
}

function hasCopilotVisionInput(messages: Context["messages"]): boolean {
  return messages.some((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return message.content.some((item) => containsCopilotContentType(item, "image"));
    }
    if (message.role === "toolResult" && Array.isArray(message.content)) {
      return message.content.some((item) => containsCopilotContentType(item, "image"));
    }
    return false;
  });
}

export function buildCopilotDynamicHeaders(params: {
  messages: Context["messages"];
  hasImages: boolean;
}): Record<string, string> {
  return {
    ...buildCopilotIdeHeaders(),
    "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
    "Openai-Organization": "github-copilot",
    "x-initiator": inferCopilotInitiator(params.messages),
    ...(params.hasImages ? { "Copilot-Vision-Request": "true" } : {}),
  };
}

function patchOnPayloadResult(
  result: unknown,
  originalPayload: unknown,
  model: Parameters<StreamFn>[0],
  patchPayload?: CopilotPayloadPatch,
): unknown {
  const patch = (replacementPayload: unknown) => {
    const payload = replacementPayload === undefined ? originalPayload : replacementPayload;
    rewriteCopilotResponsePayloadConnectionBoundIds(payload);
    if (isRecord(payload)) {
      patchPayload?.(payload, model);
    }
    return replacementPayload === undefined ? undefined : payload;
  };
  if (result && typeof result === "object" && "then" in result) {
    return Promise.resolve(result).then(patch);
  }
  return patch(result);
}

function buildCopilotRequestHeaders(
  context: Parameters<StreamFn>[1],
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages: hasCopilotVisionInput(context.messages),
    }),
    ...headers,
  };
}

function patchCopilotAnthropicPayload(payload: Record<string, unknown>): void {
  if (Array.isArray(payload.messages)) {
    payload.messages = stripCopilotAssistantThinkingMessages(payload.messages);
  }
  applyAnthropicEphemeralCacheControlMarkers(payload);
}

function shouldUseCopilotNativeWebSearch(config: ProviderWrapStreamFnContext["config"]): boolean {
  const provider = config?.tools?.web?.search?.provider;
  if (typeof provider !== "string") {
    return true;
  }
  const normalized = provider.trim().toLowerCase();
  return normalized === "" || normalized === "auto" || normalized === "openai";
}

function patchCopilotNativeWebSearchPayload(payload: Record<string, unknown>): void {
  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const hasManagedWebSearch = existingTools.some(
    (tool) => isRecord(tool) && tool.type === "function" && tool.name === "web_search",
  );
  const hasNativeWebSearch = existingTools.some(
    (tool) => isRecord(tool) && tool.type === COPILOT_NATIVE_WEB_SEARCH_TOOL.type,
  );
  if (!hasManagedWebSearch && !hasNativeWebSearch) {
    return;
  }
  const tools = existingTools.filter(
    (tool) => !(isRecord(tool) && tool.type === "function" && tool.name === "web_search"),
  );
  if (!hasNativeWebSearch) {
    tools.push(COPILOT_NATIVE_WEB_SEARCH_TOOL);
  }
  payload.tools = tools;

  const reasoning = payload.reasoning;
  if (isRecord(reasoning) && reasoning.effort === "minimal") {
    reasoning.effort = "low";
  }
}

export function wrapCopilotAnthropicStream(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "anthropic-messages") {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers: buildCopilotRequestHeaders(context, options?.headers),
      },
      patchCopilotAnthropicPayload,
    );
  };
}

export function wrapCopilotOpenAIResponsesStream(
  baseStreamFn: StreamFn | undefined,
  patchPayload?: CopilotPayloadPatch,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "openai-responses") {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    const wrappedOptions: StreamOptions = {
      ...options,
      headers: buildCopilotRequestHeaders(context, options?.headers),
      onPayload: (payload, payloadModel) => {
        rewriteCopilotResponsePayloadConnectionBoundIds(payload);
        return patchOnPayloadResult(
          originalOnPayload?.(payload, payloadModel),
          payload,
          payloadModel,
          patchPayload,
        );
      },
    };
    return underlying(model, context, wrappedOptions);
  };
}

export function wrapCopilotOpenAICompletionsStream(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "openai-completions") {
      return underlying(model, context, options);
    }

    return underlying(model, context, {
      ...options,
      headers: buildCopilotRequestHeaders(context, options?.headers),
    });
  };
}

export function wrapCopilotProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const patchPayload: CopilotPayloadPatch = (payload, model) => {
    if (
      ctx.config?.tools?.web?.search?.enabled !== false &&
      ctx.nativeWebSearchAllowedByToolPolicy !== false &&
      shouldUseCopilotNativeWebSearch(ctx.config) &&
      model.provider === "github-copilot" &&
      model.api === "openai-responses" &&
      hasNativeWebSearchTool(model)
    ) {
      patchCopilotNativeWebSearchPayload(payload);
    }
  };
  return wrapCopilotOpenAICompletionsStream(
    wrapCopilotOpenAIResponsesStream(wrapCopilotAnthropicStream(ctx.streamFn), patchPayload),
  );
}
