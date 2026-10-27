import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createAssistantMessageEventStream, streamSimple } from "openclaw/plugin-sdk/llm";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import {
  clampPositiveTimerTimeoutMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import {
  buildAssistantMessage,
  buildGuardedModelFetch,
  createEmptyTransportUsage,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import {
  asPositiveSafeInteger,
  asOptionalRecord,
  asRecord,
  filterStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { createLmstudioChatStream, type LmstudioStreamOptions } from "./chat.js";
import { LMSTUDIO_PROVIDER_ID } from "./defaults.js";
import {
  LmstudioModelLoadError,
  prepareLmstudioModelForInference,
  type LmstudioPreparedModel,
} from "./models.fetch.js";
import { normalizeLmstudioModelKey, resolveLmstudioInferenceBase } from "./models.js";
import {
  buildLmstudioAuthHeaders,
  resolveLmstudioProviderHeaders,
  resolveLmstudioRuntimeApiKey,
} from "./runtime.js";

const log = createSubsystemLogger("extensions/lmstudio/stream");

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

export function wrapLmstudioInferencePreload(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  const chat = ctx.streamFn ?? createLmstudioChatStream();
  const configuredResponseFormat = asOptionalRecord(
    asRecord(ctx.extraParams?.extra_body ?? ctx.extraParams?.extraBody).response_format,
  );
  return (rawModel, context, requestOptions) => {
    if (rawModel.provider !== LMSTUDIO_PROVIDER_ID) {
      return underlying(rawModel, context, requestOptions);
    }
    // Normalize the pass-through schema before the chat factory selects a transport.
    const options: LmstudioStreamOptions = {
      ...requestOptions,
      reasoning:
        requestOptions?.reasoning ??
        (ctx.thinkingLevel === "adaptive" ? undefined : ctx.thinkingLevel),
      lmstudioThinkingLevel: ctx.thinkingLevel,
      ...(configuredResponseFormat ? { responseFormat: configuredResponseFormat } : {}),
    };
    const model = withLmstudioUsageCompat(rawModel);
    const modelKey = normalizeLmstudioModelKey(model.id);
    if (!modelKey) {
      return underlying(model, context, options);
    }
    // Cancellation belongs to this caller; never start or join a shared load after abort.
    options?.signal?.throwIfAborted();
    const providerConfig = ctx.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID];
    if (asRecord(providerConfig?.params).preload === false) {
      return chat(model, context, options);
    }
    const resolvedBaseUrl = resolveLmstudioInferenceBase(model.baseUrl ?? providerConfig?.baseUrl);
    const requestedContextLength =
      asPositiveSafeInteger(model.contextTokens) ?? asPositiveSafeInteger(model.contextWindow);
    return (async () => {
      async function resolveLmstudioPreloadRequest() {
        const requestedTimeoutMs =
          clampPositiveTimerTimeoutMs(options?.timeoutMs ?? asRecord(model).requestTimeoutMs) ??
          finiteSecondsToTimerSafeMilliseconds(providerConfig?.timeoutSeconds);
        const providerHeaders = { ...providerConfig?.headers, ...model.headers };
        const runtimeApiKey = options?.apiKey?.trim();
        const timeoutMs = requestedTimeoutMs ?? 120_000;
        const headers = await resolveLmstudioProviderHeaders({
          config: ctx.config,
          headers: providerHeaders,
        });
        return {
          baseUrl: resolvedBaseUrl,
          apiKey:
            runtimeApiKey && !isNonSecretApiKeyMarker(runtimeApiKey)
              ? runtimeApiKey
              : await resolveLmstudioRuntimeApiKey({
                  config: ctx.config,
                  agentDir: ctx.agentDir,
                  headers: providerHeaders,
                }),
          headers,
          fetchImpl: buildGuardedModelFetch({ ...model, baseUrl: resolvedBaseUrl }, timeoutMs),
          modelKey,
          requestedContextLength,
          timeoutMs,
        };
      }
      let request: Awaited<ReturnType<typeof resolveLmstudioPreloadRequest>>;
      try {
        request = await resolveLmstudioPreloadRequest();
      } catch (error) {
        options?.signal?.throwIfAborted();
        log.warn(`LM Studio inference preload failed for "${modelKey}": ${String(error)}`);
        return chat(model, context, options);
      }
      options?.signal?.throwIfAborted();
      // Hash effective wire auth, including header casing/ordering normalization;
      // neither credentials nor credential-bearing URLs become retained cache keys.
      const preloadKey = sha256Hex(
        JSON.stringify([
          resolvedBaseUrl,
          modelKey,
          requestedContextLength ?? null,
          ctx.agentDir ?? null,
          request.timeoutMs,
          [...new Headers(buildLmstudioAuthHeaders(request)).entries()],
        ]),
      );

      const cooldown = preloadCooldown.get(preloadKey);
      const cooldownEntry = cooldown && cooldown.untilMs > Date.now() ? cooldown : undefined;
      const existing = preloadInFlight.get(preloadKey);
      const preloadPromise: Promise<LmstudioPreparedModel | undefined> | undefined =
        existing ??
        (cooldownEntry
          ? undefined
          : (() => {
              const created = prepareLmstudioModelForInference(request)
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
      const modelId = preparedModel?.modelKey;
      const streamModel = modelId && modelId !== model.id ? { ...model, id: modelId } : model;
      const instanceId = preparedModel?.instanceId;
      const stream = chat(
        streamModel,
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
