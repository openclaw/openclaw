// Opencode Go plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  composeProviderStreamWrappers,
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  isOpencodeGoKimiNoReasoningModelId,
  normalizeOpencodeGoBaseUrl,
} from "./provider-catalog.js";
import { isOpencodeGoFixedAnthropicReasoningModelId } from "./provider-policy-api.js";
import { stripOpencodeGoKimiReasoningPayload } from "./reasoning-sanitizer.js";
import {
  createOpencodeGoStalledStreamWrapper,
  OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
} from "./stream-termination.js";

const OPENCODE_SESSION_HEADER = "x-opencode-session";

function hasOpencodeSessionHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === OPENCODE_SESSION_HEADER);
}

export function createOpencodeGoSessionHeaderWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  return (model, context, options) => {
    const sessionId = options?.sessionId?.trim();
    if (
      model.provider !== "opencode-go" ||
      !normalizeOpencodeGoBaseUrl({ api: model.api, baseUrl: model.baseUrl }) ||
      !sessionId ||
      hasOpencodeSessionHeader(model.headers) ||
      hasOpencodeSessionHeader(options?.headers)
    ) {
      return baseStreamFn(model, context, options);
    }
    // OpenCode Go routes and caches each conversation by this stable provider header.
    // Forward the runtime-owned session identity instead of minting request-local values.
    return baseStreamFn(model, context, {
      ...options,
      headers: { ...options?.headers, [OPENCODE_SESSION_HEADER]: sessionId },
    });
  };
}

export function createOpencodeGoWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const wrapped =
    composeProviderStreamWrappers(
      baseStreamFn,
      (streamFn) =>
        streamFn
          ? createPayloadPatchStreamWrapper(
              streamFn,
              ({ payload }) => stripOpencodeGoKimiReasoningPayload(payload),
              {
                shouldPatch: ({ model }) =>
                  model.provider === "opencode-go" && isOpencodeGoKimiNoReasoningModelId(model.id),
              },
            )
          : undefined,
      (streamFn) => {
        if (!streamFn) {
          return undefined;
        }
        const thinkingOff = createOpenAICompatibleCompletionsThinkingOffWrapper(
          streamFn,
          thinkingLevel,
        );
        return (model, context, options) =>
          model.provider === "opencode-go" && model.id === "kimi-k3"
            ? thinkingOff(model, context, options)
            : streamFn(model, context, options);
      },
      (streamFn) =>
        streamFn
          ? createPayloadPatchStreamWrapper(
              streamFn,
              ({ payload }) => {
                delete payload.thinking;
                delete payload.output_config;
              },
              {
                shouldPatch: ({ model }) =>
                  model.provider === "opencode-go" &&
                  isOpencodeGoFixedAnthropicReasoningModelId(model.id),
              },
            )
          : undefined,
      (streamFn) =>
        createDeepSeekV4OpenAICompatibleThinkingWrapper({
          baseStreamFn: streamFn,
          thinkingLevel,
          shouldPatchModel: (model) =>
            model.provider === "opencode-go" && model.id === "deepseek-v4-flash",
          resolveReasoningEffort: (level) =>
            level === "low" ? "low" : level === "max" ? "max" : "high",
        }) ?? streamFn,
      (streamFn) =>
        createDeepSeekV4OpenAICompatibleThinkingWrapper({
          baseStreamFn: streamFn,
          thinkingLevel,
          shouldPatchModel: (model) =>
            model.provider === "opencode-go" && model.id === "deepseek-v4-pro",
        }) ?? streamFn,
    ) ?? baseStreamFn;
  // Outermost layer: provider-owned stalled SSE termination so the underlying
  // OpenAI SDK request is aborted at the raw opencode-go boundary instead of
  // waiting for the shared runtime stuck-session recovery.
  const stalledWrapped = createOpencodeGoStalledStreamWrapper(wrapped, {
    provider: "opencode-go",
    idleTimeoutMs: OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
    firstEventTimeoutMs: OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  });
  return createOpencodeGoSessionHeaderWrapper(stalledWrapped);
}
