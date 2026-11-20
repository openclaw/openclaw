import { asPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import type {
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import {
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPayloadPatchStreamWrapper,
  stripReasoningReplayPayload,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  isOpencodeGoFixedAnthropicReasoningModelId,
  isOpencodeGoKimiNoReasoningModelId,
} from "./provider-policy-api.js";

const proThinking = buildProviderStreamFamilyHooks("deepseek-v4-pro-thinking");
const flashThinking = buildProviderStreamFamilyHooks("deepseek-v4-flash-thinking");

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
        stripReasoningReplayPayload(payload);
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
  const selected: NonNullable<typeof baseStreamFn> = (model, context, options) =>
    model.provider === "opencode-go" && model.id === "kimi-k3"
      ? thinkingOff(model, context, options)
      : payloadStreamFn(model, context, options);
  const flashStream = flashThinking.wrapStreamFn!({ ...ctx, streamFn: selected }) ?? selected;
  const flashStreamFn: NonNullable<typeof baseStreamFn> = (model, context, options) =>
    model.provider === "opencode-go" &&
    (model.id === "deepseek-v4-flash" || model.id === "deepseek-v4.1-flash")
      ? flashStream(model, context, options)
      : selected(model, context, options);
  const proStream = proThinking.wrapStreamFn!({ ...ctx, streamFn: flashStreamFn }) ?? selected;
  const deepSeek: NonNullable<typeof baseStreamFn> = (model, context, options) =>
    model.provider === "opencode-go" && model.id === "deepseek-v4-pro"
      ? proStream(model, context, options)
      : (flashStreamFn ?? selected)(model, context, options);
  const sourceApi = ctx.sourceApi;
  return (model, context, options) => {
    const api = sourceApi ?? model.api;
    // OpenAI transports already consume the central policy; Anthropic does not.
    // Keep this narrow so each request resolves attribution exactly once.
    if (model.provider !== "opencode-go" || api !== "anthropic-messages") {
      return deepSeek(model, context, options);
    }
    return deepSeek(model, context, {
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
