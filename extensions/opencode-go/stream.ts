import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import {
  composeProviderStreamWrappers,
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isOpencodeGoKimiNoReasoningModelId } from "./provider-catalog.js";
import { isOpencodeGoFixedAnthropicReasoningModelId } from "./provider-policy-api.js";
import { stripOpencodeGoKimiReasoningPayload } from "./reasoning-sanitizer.js";
import {
  createOpencodeGoStalledStreamWrapper,
  OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
} from "./stream-termination.js";

function createOpencodeGoAttributionWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  sourceApi?: ProviderWrapStreamFnContext["sourceApi"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  return (model, context, options) => {
    const api = sourceApi ?? model.api;
    // OpenAI transports already consume the central policy; Anthropic does not.
    // Keep this narrow so each request resolves attribution exactly once.
    if (model.provider !== "opencode-go" || api !== "anthropic-messages") {
      return baseStreamFn(model, context, options);
    }
    return baseStreamFn(model, context, {
      ...options,
      headers: resolveProviderRequestHeaders({
        provider: model.provider,
        api,
        baseUrl: model.baseUrl,
        capability: "llm",
        transport: "stream",
        callerHeaders: options?.headers,
        precedence: "defaults-win",
      }),
    });
  };
}

function createOpencodeGoDeepSeekWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  const flashStreamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: (model) =>
      model.provider === "opencode-go" && model.id === "deepseek-v4-flash",
    resolveReasoningEffort: (level) => (level === "low" ? "low" : level === "max" ? "max" : "high"),
  });
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn: flashStreamFn,
    thinkingLevel,
    shouldPatchModel: (model) => model.provider === "opencode-go" && model.id === "deepseek-v4-pro",
  });
}

export function createOpencodeGoWireWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  const { streamFn: baseStreamFn, thinkingLevel } = ctx;
  if (!baseStreamFn) {
    return undefined;
  }
  return (
    composeProviderStreamWrappers(
      baseStreamFn,
      (streamFn) =>
        createPayloadPatchStreamWrapper(
          streamFn,
          ({ payload, model }) => {
            if (isOpencodeGoKimiNoReasoningModelId(model.id)) {
              stripOpencodeGoKimiReasoningPayload(payload);
            } else if (isOpencodeGoFixedAnthropicReasoningModelId(model.id)) {
              delete payload.thinking;
              delete payload.output_config;
            }
          },
          { shouldPatch: ({ model }) => model.provider === "opencode-go" },
        ),
      (streamFn) => {
        if (!streamFn) {
          return undefined;
        }
        const thinkingOff = createOpenAICompatibleCompletionsThinkingOffWrapper(
          streamFn,
          thinkingLevel,
          ctx.sourceApi,
        );
        return (model, context, options) =>
          model.provider === "opencode-go" && model.id === "kimi-k3"
            ? thinkingOff(model, context, options)
            : streamFn(model, context, options);
      },
      (streamFn) => createOpencodeGoDeepSeekWrapper(streamFn, thinkingLevel),
      (streamFn) => createOpencodeGoAttributionWrapper(streamFn, ctx.sourceApi),
    ) ?? baseStreamFn
  );
}

export function createOpencodeGoWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  const wrapped = createOpencodeGoWireWrapper(ctx);
  if (!wrapped) {
    return undefined;
  }
  // Outermost layer: provider-owned stalled SSE termination so the underlying
  // OpenAI SDK request is aborted at the raw opencode-go boundary instead of
  // waiting for the shared runtime stuck-session recovery.
  return createOpencodeGoStalledStreamWrapper(wrapped, {
    provider: "opencode-go",
    idleTimeoutMs: OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
    firstEventTimeoutMs: OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  });
}
