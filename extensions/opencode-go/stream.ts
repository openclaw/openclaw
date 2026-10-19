import { asPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import type {
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  isOpencodeGoFixedAnthropicReasoningModelId,
  isOpencodeGoKimiNoReasoningModelId,
} from "./provider-policy-api.js";
import { stripOpencodeGoKimiReasoningPayload } from "./reasoning-sanitizer.js";

function createOpencodeGoAttributionWrapper(
  baseStreamFn: NonNullable<ProviderWrapStreamFnContext["streamFn"]>,
  sourceApi?: ProviderWrapStreamFnContext["sourceApi"],
): NonNullable<ProviderWrapStreamFnContext["streamFn"]> {
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
  baseStreamFn: NonNullable<ProviderWrapStreamFnContext["streamFn"]>,
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): NonNullable<ProviderWrapStreamFnContext["streamFn"]> {
  const flashStreamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: (model) =>
      model.provider === "opencode-go" &&
      (model.id === "deepseek-v4-flash" || model.id === "deepseek-v4.1-flash"),
    resolveReasoningEffort: (level) => (level === "low" ? "low" : level === "max" ? "max" : "high"),
  });
  return (
    createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn: flashStreamFn,
      thinkingLevel,
      shouldPatchModel: (model) =>
        model.provider === "opencode-go" && model.id === "deepseek-v4-pro",
    }) ?? baseStreamFn
  );
}

export function createOpencodeGoWireWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  const { streamFn: baseStreamFn, thinkingLevel } = ctx;
  if (!baseStreamFn) {
    return undefined;
  }
  const payloadStreamFn = createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload, model }) => {
      if (isOpencodeGoKimiNoReasoningModelId(model.id)) {
        stripOpencodeGoKimiReasoningPayload(payload);
      } else if (isOpencodeGoFixedAnthropicReasoningModelId(model.id)) {
        delete payload.thinking;
        delete payload.output_config;
      }
    },
    { shouldPatch: ({ model }) => model.provider === "opencode-go" },
  );
  const thinkingOff = createOpenAICompatibleCompletionsThinkingOffWrapper(
    payloadStreamFn,
    thinkingLevel,
    ctx.sourceApi,
  );
  const deepSeek = createOpencodeGoDeepSeekWrapper(
    (model, context, options) =>
      model.provider === "opencode-go" && model.id === "kimi-k3"
        ? thinkingOff(model, context, options)
        : payloadStreamFn(model, context, options),
    thinkingLevel,
  );
  return createOpencodeGoAttributionWrapper(deepSeek, ctx.sourceApi);
}

export function createOpencodeGoWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  const wrapped = createOpencodeGoWireWrapper(ctx);
  if (!wrapped) {
    return undefined;
  }
  // The transport owns first-SSE timing; the runner owns creation/idle abort and
  // cron failover. Do not hide its native stream/activity signal behind another pump.
  return (model, context, options) => {
    const runtimeModel: ProviderRuntimeModel = model;
    const requestOptions =
      model.provider === "opencode-go"
        ? {
            ...options,
            firstEventTimeoutMs: asPositiveFiniteNumber(runtimeModel.requestTimeoutMs) ?? 300_000,
          }
        : options;
    return wrapped(model, context, requestOptions);
  };
}
