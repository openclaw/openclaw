import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createAssistantMessageEventStream, streamSimple } from "openclaw/plugin-sdk/llm";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import {
  clampPositiveTimerTimeoutMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPlainTextToolCallCompatWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  buildAssistantMessage,
  createEmptyTransportUsage,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asPositiveSafeInteger,
  asRecord,
  filterStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import {
  LmstudioModelLoadError,
  prepareLmstudioModelForInference,
  type LmstudioPreparedModel,
} from "./models.fetch.js";
import { normalizeLmstudioModelKey, resolveLmstudioInferenceBase } from "./models.js";
import { resolveLmstudioProviderHeaders, resolveLmstudioRuntimeApiKey } from "./runtime.js";

const log = createSubsystemLogger("extensions/lmstudio/stream");

type StreamOptions = Parameters<StreamFn>[2];
type StreamModel = Parameters<StreamFn>[0];

const preloadInFlight = new Map<string, Promise<LmstudioPreparedModel | undefined>>();

// Back off repeated load failures without blocking inference for models already loaded in the UI.
type PreloadCooldownEntry = {
  untilMs: number;
  error: unknown;
  resolvedModelKey?: string;
};

const preloadCooldown = new Map<string, PreloadCooldownEntry>();
const PRELOAD_RETRY_COOLDOWN_MS = 60_000;

function withLmstudioUsageCompat(model: StreamModel): StreamModel {
  const compat = model.compat ?? {};
  const unsupportedToolSchemaKeywords =
    "unsupportedToolSchemaKeywords" in compat
      ? filterStringEntries(compat.unsupportedToolSchemaKeywords)
      : [];
  const normalizedCompat = {
    ...compat,
    supportsUsageInStreaming: true,
    // LM Studio's GGUF grammar rejects regex constraints; the shared transport
    // removes this keyword recursively while preserving native tool calling.
    unsupportedToolSchemaKeywords: uniqueStrings([...unsupportedToolSchemaKeywords, "pattern"]),
  };
  return {
    ...model,
    compat: normalizedCompat,
  };
}

async function prepareLmstudioInference(params: {
  baseUrl: string;
  modelKey: string;
  requestedContextLength?: number;
  timeoutMs?: number;
  options: StreamOptions;
  ctx: ProviderWrapStreamFnContext;
  modelHeaders?: Record<string, string>;
}): Promise<LmstudioPreparedModel> {
  const providerConfig = params.ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID];
  const providerHeaders = { ...providerConfig?.headers, ...params.modelHeaders };
  const runtimeApiKey = params.options?.apiKey?.trim() || undefined;
  const headers = await resolveLmstudioProviderHeaders({
    config: params.ctx.config,
    headers: providerHeaders,
  });
  const configuredApiKey =
    runtimeApiKey !== undefined
      ? undefined
      : await resolveLmstudioRuntimeApiKey({
          config: params.ctx.config,
          agentDir: params.ctx.agentDir,
          headers: providerHeaders,
        });

  return await prepareLmstudioModelForInference({
    baseUrl: params.baseUrl,
    apiKey: runtimeApiKey ?? configuredApiKey,
    headers,
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
    modelKey: params.modelKey,
    requestedContextLength: params.requestedContextLength,
    timeoutMs: params.timeoutMs,
  });
}

export function wrapLmstudioInferencePreload(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  // LM Studio does not ride the shared OpenAI provider hook stack, so the
  // thinking-level payload rewrite must be composed here: without it, thinking
  // "off" leaves the transport's defaulted reasoning_effort (an enabled level)
  // in requests to binary-thinking servers.
  const streamWithThinkingLevel = createOpenAICompatibleCompletionsThinkingOffWrapper(
    createPlainTextToolCallCompatWrapper(underlying),
    ctx.thinkingLevel,
  );
  return (model, context, options) => {
    if (model.provider !== LMSTUDIO_PROVIDER_ID) {
      return underlying(model, context, options);
    }
    const modelKey = normalizeLmstudioModelKey(model.id);
    if (!modelKey) {
      return underlying(model, context, options);
    }
    // Cancellation belongs to this caller; never start or join a shared load after abort.
    options?.signal?.throwIfAborted();
    const providerConfig = ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID];
    if (asRecord(providerConfig?.params).preload === false) {
      return streamWithThinkingLevel(withLmstudioUsageCompat(model), context, options);
    }
    const resolvedBaseUrl = resolveLmstudioInferenceBase(model.baseUrl ?? providerConfig?.baseUrl);
    const requestedContextLength =
      asPositiveSafeInteger(model.contextTokens) ?? asPositiveSafeInteger(model.contextWindow);
    const preloadKey = `${resolvedBaseUrl}::${modelKey}::${requestedContextLength ?? "default"}`;

    const cooldown = preloadCooldown.get(preloadKey);
    const cooldownEntry = cooldown && cooldown.untilMs > Date.now() ? cooldown : undefined;
    const existing = preloadInFlight.get(preloadKey);
    const preloadPromise: Promise<LmstudioPreparedModel | undefined> | undefined =
      existing ??
      (cooldownEntry
        ? undefined
        : (() => {
            const created = prepareLmstudioInference({
              baseUrl: resolvedBaseUrl,
              modelKey,
              requestedContextLength,
              timeoutMs:
                clampPositiveTimerTimeoutMs(
                  options?.timeoutMs ?? asRecord(model).requestTimeoutMs,
                ) ?? finiteSecondsToTimerSafeMilliseconds(providerConfig?.timeoutSeconds),
              options,
              ctx,
              modelHeaders: model.headers,
            })
              .then(
                (preparedModel) => {
                  preloadCooldown.delete(preloadKey);
                  return preparedModel;
                },
                (error: unknown) => {
                  const previous = preloadCooldown.get(preloadKey);
                  preloadCooldown.set(preloadKey, {
                    untilMs: Date.now() + PRELOAD_RETRY_COOLDOWN_MS,
                    error:
                      previous?.error instanceof LmstudioModelLoadError &&
                      previous.error.requiredContextLength !== undefined
                        ? previous.error
                        : error,
                    resolvedModelKey:
                      error instanceof LmstudioModelLoadError
                        ? error.resolvedModelKey
                        : previous?.resolvedModelKey,
                  });
                  throw error;
                },
              )
              .finally(() => {
                preloadInFlight.delete(preloadKey);
              });
            preloadInFlight.set(preloadKey, created);
            return created;
          })());

    return (async () => {
      let preparedModel: LmstudioPreparedModel | undefined;
      let failure = cooldownEntry;
      if (preloadPromise) {
        try {
          preparedModel = await racePromiseWithAbortSignal(
            preloadPromise,
            options?.signal,
            (signal) => toErrorObject(signal.reason, "LM Studio preload aborted"),
          );
        } catch {
          // Cancellation belongs to this waiter, never to the shared load or its backoff.
          options?.signal?.throwIfAborted();
          failure = preloadCooldown.get(preloadKey);
        }
      }
      if (failure) {
        const error = failure.error;
        if (preloadPromise) {
          log.warn(`LM Studio inference preload failed for "${modelKey}": ${String(error)}`);
        }
        if (error instanceof LmstudioModelLoadError && error.requiredContextLength !== undefined) {
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "error",
            reason: "error",
            error: {
              ...buildAssistantMessage({
                model,
                content: [],
                stopReason: "error",
                usage: createEmptyTransportUsage(),
              }),
              errorMessage: error.message,
              errorCode: "model_load_failed",
              errorBody: JSON.stringify({ requestedContextLength: error.requiredContextLength }),
            },
          });
          stream.end();
          return stream;
        }
        const resolvedModelKey = failure.resolvedModelKey;
        preparedModel = resolvedModelKey ? { modelKey: resolvedModelKey } : undefined;
      }
      // LM Studio uses OpenAI-compatible streaming usage payloads when requested via
      // `stream_options.include_usage`. Force this compat flag at call time so usage
      // reporting remains enabled even when catalog entries omitted compat metadata.
      const modelId = preparedModel?.modelKey;
      const streamModel = modelId && modelId !== model.id ? { ...model, id: modelId } : model;
      const instanceId = preparedModel?.instanceId;
      const stream = streamWithThinkingLevel(
        withLmstudioUsageCompat(streamModel),
        context,
        instanceId
          ? {
              ...options,
              async onPayload(payload, payloadModel) {
                // Instance IDs route this request; model and transcript identity stay canonical.
                asRecord(payload).model = instanceId;
                const replacement = await options?.onPayload?.(payload, payloadModel);
                asRecord(replacement ?? payload).model = instanceId;
                return replacement;
              },
            }
          : options,
      );
      return await stream;
    })();
  };
}
