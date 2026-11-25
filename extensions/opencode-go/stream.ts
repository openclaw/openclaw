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
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isOpencodeGoFixedAnthropicReasoningModelId,
  isOpencodeGoKimiNoReasoningModelId,
} from "./provider-policy-api.js";

const REASONING_REPLAY_FIELDS = [
  "reasoning_details",
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function stripReasoningReplayFields(value: unknown): void {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return;
  }
  for (const field of REASONING_REPLAY_FIELDS) {
    delete record[field];
  }

  const content = record.content;
  if (Array.isArray(content)) {
    const nextContent = stripReasoningReplayItems(content);
    record.content =
      nextContent.length > 0
        ? nextContent
        : [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }];
  }
}

function stripReasoningReplayItems(items: unknown[]): unknown[] {
  const retained = [];
  for (const item of items) {
    const type = asOptionalObjectRecord(item)?.type;
    if (type !== "thinking" && type !== "redacted_thinking" && type !== "reasoning") {
      stripReasoningReplayFields(item);
      retained.push(item);
    }
  }
  return retained;
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
        stripReasoningReplayFields(payload);
        delete payload.reasoning_effort;
        delete payload.reasoningEffort;
        for (const key of ["messages", "input"] as const) {
          if (Array.isArray(payload[key])) {
            payload[key] = stripReasoningReplayItems(payload[key]);
          }
        }
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
  const flashStreamFn = createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn: selected,
    thinkingLevel,
    shouldPatchModel: (model) =>
      model.provider === "opencode-go" &&
      (model.id === "deepseek-v4-flash" || model.id === "deepseek-v4.1-flash"),
    resolveReasoningEffort: (level) => (level === "low" ? "low" : level === "max" ? "max" : "high"),
  });
  const deepSeek =
    createDeepSeekV4OpenAICompatibleThinkingWrapper({
      baseStreamFn: flashStreamFn,
      thinkingLevel,
      shouldPatchModel: (model) =>
        model.provider === "opencode-go" && model.id === "deepseek-v4-pro",
    }) ?? selected;
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
