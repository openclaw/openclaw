import { streamWithPayloadPatch } from "../llm/providers/stream-wrappers/stream-payload-utils.js";
import { log } from "./embedded-agent-runner/logger.js";
import { resolveAliasedParamValue, sanitizeExtraParamsRecord } from "./model-extra-params.js";
import {
  getModelProviderRequestRouteFacts,
  resolveProviderRequestPolicyConfig,
} from "./provider-request-config.js";
import type { StreamFn } from "./runtime/index.js";

function shouldStripOpenAICompletionsStore(model: Parameters<StreamFn>[0]): boolean {
  if (model.api !== "openai-completions") {
    return false;
  }
  const compat =
    model.compat && typeof model.compat === "object"
      ? Object.fromEntries(Object.entries(model.compat))
      : undefined;
  const capabilities =
    getModelProviderRequestRouteFacts(model)?.capabilities ??
    resolveProviderRequestPolicyConfig({
      provider: typeof model.provider === "string" ? model.provider : undefined,
      api: model.api,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      compat,
      capability: "llm",
      transport: "stream",
    }).capabilities;
  return !capabilities.usesKnownNativeOpenAIRoute;
}

function createOpenAICompletionsStoreCompatWrapper(underlying: StreamFn): StreamFn {
  return (model, context, options) => {
    if (!shouldStripOpenAICompletionsStore(model)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      delete payloadObj.store;
    });
  };
}

function resolveExtraBodyRecord(
  value: unknown,
  param: "extra_body" | "chat_template_kwargs",
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    log.warn(
      `ignoring invalid ${param} param: ${typeof value === "string" ? value : typeof value}`,
    );
    return undefined;
  }
  const record = Object.fromEntries(
    Object.entries(sanitizeExtraParamsRecord(value) ?? {}).filter(
      ([, entry]) => entry !== undefined,
    ),
  );
  return Object.keys(record).length > 0 ? record : undefined;
}

function createOpenAICompletionsChatTemplateKwargsWrapper(
  underlying: StreamFn,
  configured: Record<string, unknown>,
): StreamFn {
  return (model, context, options) => {
    if (model.api !== "openai-completions") {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      const existing = payloadObj.chat_template_kwargs;
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        payloadObj.chat_template_kwargs = {
          ...existing,
          ...configured,
        };
        return;
      }
      payloadObj.chat_template_kwargs = configured;
    });
  };
}

const FRAMEWORK_MANAGED_EXTRA_BODY_KEYS = new Set(["messages", "model", "stream"]);

function createOpenAICompletionsExtraBodyWrapper(
  underlying: StreamFn,
  extraBody: Record<string, unknown>,
): StreamFn {
  return (model, context, options) => {
    if (model.api !== "openai-completions") {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      const clobberedManagedKeys = Object.keys(extraBody).filter(
        (key) => Object.hasOwn(payloadObj, key) && FRAMEWORK_MANAGED_EXTRA_BODY_KEYS.has(key),
      );
      if (clobberedManagedKeys.length > 0) {
        log.warn(
          `extra_body overrides framework-managed request keys: ${clobberedManagedKeys.join(", ")}`,
        );
      }
      Object.assign(payloadObj, extraBody);
    });
  };
}

/** Apply configured payload fields before removing store from non-native completion routes. */
export function createOpenAICompletionsPayloadPolicyWrapper(
  streamFn: StreamFn,
  sources: ReadonlyArray<Record<string, unknown> | undefined>,
): StreamFn {
  let wrappedStreamFn = streamFn;
  const configuredChatTemplateKwargs = resolveExtraBodyRecord(
    resolveAliasedParamValue(sources, ["chat_template_kwargs", "chatTemplateKwargs"]),
    "chat_template_kwargs",
  );
  if (configuredChatTemplateKwargs) {
    wrappedStreamFn = createOpenAICompletionsChatTemplateKwargsWrapper(
      wrappedStreamFn,
      configuredChatTemplateKwargs,
    );
  }
  const extraBody = resolveExtraBodyRecord(
    resolveAliasedParamValue(sources, ["extra_body", "extraBody"]),
    "extra_body",
  );
  if (extraBody) {
    wrappedStreamFn = createOpenAICompletionsExtraBodyWrapper(wrappedStreamFn, extraBody);
  }
  return createOpenAICompletionsStoreCompatWrapper(wrappedStreamFn);
}
