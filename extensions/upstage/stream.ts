import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

const ALLOWED_EXTRA_PARAM_KEYS = new Set([
  "frequency_penalty",
  "frequencyPenalty",
  "max_tokens",
  "maxTokens",
  "parallel_tool_calls",
  "parallelToolCalls",
  "presence_penalty",
  "presencePenalty",
  "prompt_cache_key",
  "promptCacheKey",
  "reasoning_effort",
  "reasoningEffort",
  "response_format",
  "responseFormat",
  "temperature",
  "tool_choice",
  "toolChoice",
  "top_p",
  "topP",
]);

const PAYLOAD_FIELD_ALIASES: Record<string, string> = {
  frequencyPenalty: "frequency_penalty",
  maxTokens: "max_tokens",
  parallelToolCalls: "parallel_tool_calls",
  presencePenalty: "presence_penalty",
  promptCacheKey: "prompt_cache_key",
  reasoningEffort: "reasoning_effort",
  responseFormat: "response_format",
  toolChoice: "tool_choice",
  topP: "top_p",
};

const ALLOWED_PAYLOAD_KEYS = new Set([
  "frequency_penalty",
  "max_tokens",
  "messages",
  "model",
  "parallel_tool_calls",
  "presence_penalty",
  "prompt_cache_key",
  "reasoning_effort",
  "response_format",
  "stream",
  "temperature",
  "tool_choice",
  "tools",
  "top_p",
]);

function stripUnsupportedStrictFlag(tool: unknown): unknown {
  if (!tool || typeof tool !== "object") {
    return tool;
  }
  const toolObj = tool as Record<string, unknown>;
  const fn = toolObj.function;
  if (!fn || typeof fn !== "object") {
    return tool;
  }
  const fnObj = fn as Record<string, unknown>;
  if (typeof fnObj.strict !== "boolean") {
    return tool;
  }
  const nextFunction = { ...fnObj };
  delete nextFunction.strict;
  return { ...toolObj, function: nextFunction };
}

export function prepareUpstageExtraParams(
  extraParams: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extraParams) {
    return extraParams;
  }
  return Object.fromEntries(
    Object.entries(extraParams).filter(([key, value]) => {
      if (value === undefined) {
        return false;
      }
      return ALLOWED_EXTRA_PARAM_KEYS.has(key);
    }),
  );
}

export function createUpstagePayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          for (const [sourceKey, targetKey] of Object.entries(PAYLOAD_FIELD_ALIASES)) {
            if (payloadObj[sourceKey] !== undefined && payloadObj[targetKey] === undefined) {
              payloadObj[targetKey] = payloadObj[sourceKey];
            }
            delete payloadObj[sourceKey];
          }
          delete payloadObj.reasoning;
          delete payloadObj.reasoning_summary;
          delete payloadObj.reasoningSummary;
          delete payloadObj.store;
          delete payloadObj.metadata;
          delete payloadObj.modalities;
          delete payloadObj.audio;
          delete payloadObj.prediction;
          delete payloadObj.service_tier;
          delete payloadObj.serviceTier;
          delete payloadObj.prompt_cache_retention;
          delete payloadObj.promptCacheRetention;
          delete payloadObj.stream_options;
          delete payloadObj.streamOptions;
          if (Array.isArray(payloadObj.tools)) {
            payloadObj.tools = payloadObj.tools.map((tool) => stripUnsupportedStrictFlag(tool));
          }
          for (const key of Object.keys(payloadObj)) {
            if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
              delete payloadObj[key];
            }
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
