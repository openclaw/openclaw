import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderStreamFamilyHooks } from "openclaw/plugin-sdk/provider-stream-family";
import {
  composeProviderStreamWrappers,
  createPayloadPatchStreamWrapper,
  normalizeOpenAICompatibleReasoningReplay,
  stripTrailingAssistantPrefillMessages,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { asNonArrayRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isOpenRouterDeepSeekV4ModelId, normalizeOpenRouterModelFamilyId } from "./models.js";
import {
  isOpenRouterProxyReasoningUnsupportedModel,
  normalizeOpenRouterBaseUrl,
  OPENROUTER_BASE_URL,
} from "./provider-catalog.js";

const log = createSubsystemLogger("openrouter-stream");
const openRouterThinkingStreamHooks = buildProviderStreamFamilyHooks("openrouter-thinking");

function normalizeOpenRouterStringPreservingEmpty(value: unknown): string | undefined {
  return readStringValue(value)?.trim();
}

function isVerifiedOpenRouterRoute(model: Parameters<StreamFn>[0]): boolean {
  const provider = normalizeOpenRouterStringPreservingEmpty(model.provider)?.toLowerCase();
  const baseUrl = normalizeOpenRouterStringPreservingEmpty(model.baseUrl);
  if (baseUrl) {
    return normalizeOpenRouterBaseUrl(baseUrl) === OPENROUTER_BASE_URL;
  }
  return provider === "openrouter";
}

function shouldPatchOpenRouterPayload(
  model: Parameters<StreamFn>[0],
  sourceApi?: ProviderWrapStreamFnContext["sourceApi"],
): boolean {
  // Standalone dispatch aliases retain the original API as their wire-policy owner.
  const api = normalizeOpenRouterStringPreservingEmpty(sourceApi ?? model.api);
  return (api === undefined || api === "openai-completions") && isVerifiedOpenRouterRoute(model);
}

function mergeOpenRouterAuthHeaders(options: Parameters<StreamFn>[2]): Parameters<StreamFn>[2] {
  const apiKey = normalizeOpenRouterStringPreservingEmpty(options?.apiKey);
  if (!apiKey) {
    return options;
  }
  const headers = new Headers((options as { headers?: HeadersInit } | undefined)?.headers);
  if (!headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return {
    ...options,
    headers: Object.fromEntries(headers.entries()),
  } as Parameters<StreamFn>[2];
}

function createOpenRouterAuthHeaderWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return baseStreamFn;
  }
  return (model, context, options) =>
    baseStreamFn(
      model,
      context,
      isVerifiedOpenRouterRoute(model) ? mergeOpenRouterAuthHeaders(options) : options,
    );
}

function assistantMessageHasOpenAIToolCalls(message: Record<string, unknown>): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function isEnabledReasoningValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "off" && normalized !== "none";
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const reasoning = value as Record<string, unknown>;
    if (reasoning.enabled === false) {
      return false;
    }
    const effort = reasoning.effort;
    if (typeof effort === "string") {
      const normalized = effort.trim().toLowerCase();
      return normalized !== "" && normalized !== "off" && normalized !== "none";
    }
  }
  return true;
}

function isOpenRouterReasoningPayloadEnabled(payload: Record<string, unknown>): boolean {
  return (
    isEnabledReasoningValue(payload.reasoning) || isEnabledReasoningValue(payload.reasoning_effort)
  );
}

function injectOpenRouterRouting(
  baseStreamFn: StreamFn | undefined,
  providerRouting?: Record<string, unknown>,
  sourceApi?: ProviderWrapStreamFnContext["sourceApi"],
): StreamFn | undefined {
  if (!providerRouting) {
    return baseStreamFn;
  }
  const routedStreamFn: StreamFn = (model, context, options) =>
    (
      baseStreamFn ??
      ((nextModel) => {
        throw new Error(
          `OpenRouter routing wrapper requires an underlying streamFn for ${nextModel.id}.`,
        );
      })
    )(
      {
        ...model,
        compat: { ...model.compat, openRouterRouting: providerRouting },
      } as typeof model,
      context,
      options,
    );
  return createPayloadPatchStreamWrapper(
    routedStreamFn,
    ({ payload }) => {
      if (payload.provider === undefined) {
        payload.provider = providerRouting;
      }
    },
    {
      shouldPatch: ({ model }) => shouldPatchOpenRouterPayload(model, sourceApi),
    },
  );
}

function createOpenRouterAnthropicPrefillWrapper(
  baseStreamFn: StreamFn | undefined,
  sourceApi?: ProviderWrapStreamFnContext["sourceApi"],
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      if (!isOpenRouterReasoningPayloadEnabled(payload)) {
        return;
      }
      const stripped = stripTrailingAssistantPrefillMessages(payload);
      if (stripped > 0) {
        log.warn(
          `removed ${stripped} trailing assistant prefill message${stripped === 1 ? "" : "s"} because OpenRouter-routed Anthropic reasoning requires conversations to end with a user turn`,
        );
      }
    },
    {
      shouldPatch: ({ model }) =>
        shouldPatchOpenRouterPayload(model, sourceApi) &&
        normalizeOpenRouterModelFamilyId(model.id)?.startsWith("anthropic/") === true,
    },
  );
}

function createOpenRouterDeepSeekV4ReplayWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
  sourceApi?: ProviderWrapStreamFnContext["sourceApi"],
): StreamFn {
  return createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload, model, options }) => {
      delete payload.thinking;
      delete payload.reasoning_effort;
      const compat = asNonArrayRecord(model.compat);
      if (compat.supportsReasoningEffort !== false && !compat.supportedReasoningEfforts) {
        const requestedLevel = options?.reasoning ?? thinkingLevel;
        // Configured rows without discovery metadata retain the documented V4 aliases.
        // Declared model efforts are already normalized by the transport owner.
        payload.reasoning = {
          ...asNonArrayRecord(payload.reasoning),
          effort:
            requestedLevel === "off"
              ? "none"
              : requestedLevel === "max" || requestedLevel === "xhigh"
                ? "xhigh"
                : "high",
        };
      }
      normalizeOpenAICompatibleReasoningReplay(payload, {
        // DeepSeek defaults on; omitted effort is not a request to discard its required replay.
        thinkingEnabled:
          payload.reasoning === undefined || isOpenRouterReasoningPayloadEnabled(payload),
        shouldBackfillAssistantMessage: (message) => !assistantMessageHasOpenAIToolCalls(message),
      });
    },
    {
      shouldPatch: ({ model }) =>
        shouldPatchOpenRouterPayload(model, sourceApi) && isOpenRouterDeepSeekV4ModelId(model.id),
    },
  );
}

export function wrapOpenRouterProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | null | undefined {
  const providerRouting =
    ctx.extraParams?.provider != null && typeof ctx.extraParams.provider === "object"
      ? (ctx.extraParams.provider as Record<string, unknown>)
      : undefined;
  const routedStreamFn = providerRouting
    ? injectOpenRouterRouting(ctx.streamFn, providerRouting, ctx.sourceApi)
    : ctx.streamFn;
  const wrapStreamFn = openRouterThinkingStreamHooks.wrapStreamFn ?? undefined;
  return composeProviderStreamWrappers(
    routedStreamFn,
    wrapStreamFn &&
      ((streamFn) =>
        wrapStreamFn({
          ...ctx,
          modelId: normalizeOpenRouterModelFamilyId(ctx.modelId) ?? ctx.modelId,
          streamFn,
          thinkingLevel: isOpenRouterProxyReasoningUnsupportedModel(ctx.modelId)
            ? undefined
            : ctx.thinkingLevel,
        }) ?? undefined),
    (streamFn) =>
      createOpenRouterDeepSeekV4ReplayWrapper(streamFn, ctx.thinkingLevel, ctx.sourceApi),
    createOpenRouterAuthHeaderWrapper,
    (streamFn) => createOpenRouterAnthropicPrefillWrapper(streamFn, ctx.sourceApi),
  );
}
