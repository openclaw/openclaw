import { randomUUID } from "node:crypto";
import type { AssistantMessage, Model, StreamFn } from "@openclaw/llm-core";
import OpenAI, { AzureOpenAI } from "openai";
import { getEnvApiKey } from "../env-api-keys.js";
import { getAiTransportHost } from "../host.js";
import { codeModeToolSurfaceObserver } from "../provider-options.js";
import { resolveAzureDeploymentNameFromMap } from "../providers/azure-deployment-map.js";
import { isOpenAICompatibleAzureResponsesBaseUrl } from "../providers/azure-openai-responses-client-compat.js";
import { applyResponsesServiceTierPricing } from "../providers/openai-responses-shared.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../utils/stream-first-event-timeout.js";
import { buildGuardedModelFetch } from "./host-policy.js";
import { prepareModelRequestBody } from "./model-request-body.js";
import { emitModelTransportDebug, emitModelTransportError } from "./model-transport-debug.js";
import { formatModelTransportDebugBaseUrl } from "./model-transport-url.js";
import { isOpenAICodexResponsesModel } from "./openai-completions-compat.js";
import { postOpenAIResponsesCompaction } from "./openai-responses-compact-client.js";
import { claimResponsesCompactRequest } from "./openai-responses-compact-request.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
  type OpenAIResponsesReplayMode,
} from "./openai-responses-compaction-replay.js";
import { recordResponsesContextUsage } from "./openai-responses-context-usage.js";
import {
  claimOpenAIResponsesHttpContinuation,
  type ResponsesContinuationRequest,
} from "./openai-responses-continuation.js";
import {
  AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
  OpenAIResponsesWebSocketPostDispatchError,
  responsesServiceTierObserver,
  type OpenAIResponsesOptions,
} from "./openai-responses-contracts.js";
import {
  logResponsesFailedNoDetails,
  ResponsesStreamFailure,
  safeDebugValue,
  summarizeOpenAITransportError,
  summarizeResponsesPayload,
} from "./openai-responses-debug.js";
import { supportsNativeOpenAIResponsesEndpoint } from "./openai-responses-endpoint.js";
import { recordResponsesInputReplay } from "./openai-responses-input-replay.js";
import {
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "./openai-responses-params-internal.js";
import { resolveOpenAIResponsesPayloadPolicy } from "./openai-responses-payload-policy.js";
import { createResponsesPromptEgressObserver } from "./openai-responses-prompt-observer-internal.js";
import {
  recordResponsesReasoningState,
  restoreResponsesReasoningState,
} from "./openai-responses-reasoning-state.js";
import { supportsResponsesReasoningUpdate } from "./openai-responses-reasoning-update.js";
import {
  createOpenAIResponsesAssistantOutput,
  createResponsesStreamWithRecovery,
  resolveAzureOpenAIApiVersion,
} from "./openai-responses-replay-internal.js";
import { createResponsesRequestFetch } from "./openai-responses-request-fetch.js";
import {
  responsesRequestLifecycle,
  withResponsesRequestAcceptance,
} from "./openai-responses-request-lifecycle.js";
import { projectResponsesSteeringInput } from "./openai-responses-steering.js";
import { hasOnlyResponsesFunctionTools } from "./openai-responses-stream-errors.js";
import { processResponsesStream } from "./openai-responses-stream-internal.js";
import { observeResponsesStream } from "./openai-responses-stream-observer-internal.js";
import { createRecoverableResponsesWebSocketStream } from "./openai-responses-websocket-recovery.js";
import {
  createOpenAIResponsesWebSocketStream,
  type OpenAIResponsesWebSocketMode,
} from "./openai-responses-websocket.js";
import {
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  enforceCodeModeResponsesToolSurface,
  resolveCodeModeResponsesVisibleToolNames,
} from "./openai-transport-params.js";
import {
  createResponseModelTracker,
  createOpenAIProviderAcceptanceHook,
  log,
  resolveOpenAIClientBaseUrl,
} from "./openai-transport-shared.js";
import {
  filterProviderTurnHeadersForExplicitOpencodeSession,
  resolveProviderTransportTurnState,
} from "./provider-transport-turn-state.js";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";
import {
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  transportAbortError,
  withProviderResponseHook,
} from "./transport-stream-shared.js";
import { redactIdentifier } from "./transport-utils.js";

function resolveNativeOpenAIResponsesWebSocketMode(
  model: Model,
  transport: OpenAIResponsesOptions["transport"],
): OpenAIResponsesWebSocketMode | undefined {
  if (transport !== "websocket" && transport !== "websocket-cached" && transport !== "auto") {
    return undefined;
  }
  if (getAiTransportHost().requiresManagedTransport(model)) {
    return undefined;
  }
  return supportsNativeOpenAIResponsesEndpoint(model) ? transport : undefined;
}

function combineWebSocketTimeoutSignal(
  signal: AbortSignal,
  model: Model,
  timeoutMs: number | undefined,
) {
  const resolvedTimeoutMs =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : getAiTransportHost().resolveModelRequestTimeoutMs(model);
  if (resolvedTimeoutMs === undefined || !Number.isFinite(resolvedTimeoutMs)) {
    return signal;
  }
  return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, resolvedTimeoutMs))]);
}

export function createOpenAIResponsesClient(
  model: Model,
  apiKey: string,
  defaultHeaders: Record<string, string>,
  fetchOverride?: typeof globalThis.fetch,
) {
  return new OpenAI({
    apiKey,
    baseURL: resolveOpenAIClientBaseUrl(model),
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    fetch: fetchOverride ?? buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  });
}

type ResponsesPricingOptions = Pick<
  NonNullable<Parameters<typeof processResponsesStream>[4]>,
  "serviceTier" | "applyServiceTierPricing"
>;
type ResponsesStreamParams = Parameters<typeof createResponsesStreamWithRecovery>[0] & {
  requestOptions: ReturnType<typeof buildOpenAISdkRequestOptions>;
};

type ResponsesTransportExecutorOptions = {
  outputApi?: AssistantMessage["api"];
  firstEventTimeoutMs?: number;
  streamRequest?: boolean;
  httpContinuation?: boolean;
  createClient: typeof createOpenAIResponsesClient;
  buildRequest: typeof buildOpenAIResponsesParams;
  pricingOptions?: (
    options: OpenAIResponsesOptions | undefined,
    model: Model,
  ) => ResponsesPricingOptions;
};

function createResponsesTransportExecutor(config: ResponsesTransportExecutorOptions): StreamFn {
  return (model, context, options) => {
    const responsesOptions = options as OpenAIResponsesOptions | undefined;
    const compactRequest = claimResponsesCompactRequest(responsesOptions);
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output = createOpenAIResponsesAssistantOutput(model, config.outputApi);
      let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
      let continuationClaim: ReturnType<typeof claimOpenAIResponsesHttpContinuation>;
      const requestLifecycle = responsesRequestLifecycle.get(options);
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const websocketMode = resolveNativeOpenAIResponsesWebSocketMode(
          model,
          responsesOptions?.transport,
        );
        const encodeBody = prepareModelRequestBody(
          websocketMode || compactRequest ? undefined : options,
        );
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: websocketMode ? "websocket" : "stream",
        });
        const websocketSessionPolicy = websocketMode ? turnState?.websocket : undefined;
        const httpTurnHeaders = filterProviderTurnHeadersForExplicitOpencodeSession(
          model,
          options,
          turnState?.headers,
        );
        const websocketTurnHeaders = filterProviderTurnHeadersForExplicitOpencodeSession(
          model,
          options,
          websocketSessionPolicy?.headers,
        );
        const websocketHeaders = websocketMode
          ? buildOpenAIClientHeaders(
              model,
              context,
              options?.headers,
              websocketTurnHeaders,
              options?.sessionId,
              options?.cacheRetention,
            )
          : undefined;
        const httpHeaders = buildOpenAIClientHeaders(
          model,
          context,
          options?.headers,
          httpTurnHeaders,
          options?.sessionId,
          options?.cacheRetention,
        );
        const fetchOverride = createResponsesRequestFetch(model, {
          compact: Boolean(compactRequest),
          stream: config.streamRequest,
          lifecycle: requestLifecycle,
          // The SDK replaces the fetch signal; retain the watchdog caller signal.
          onSseComment: () => notifyLlmRequestActivity(options?.signal, false),
        });
        const client = config.createClient(model, apiKey, httpHeaders, fetchOverride);
        const nativeAstra =
          model.id === "gpt-6-astra" && supportsNativeOpenAIResponsesEndpoint(model);
        const asyncToolExecutionEligible =
          nativeAstra &&
          options?.asyncToolExecution === true &&
          !responsesOptions?.openclawCodeModeToolSurface;
        const prepareRequest = async (request: ReturnType<typeof config.buildRequest>) => {
          let params = request;
          const nextParams = await options?.onPayload?.(params, model);
          if (nextParams !== undefined) {
            params = nextParams as typeof params;
          }
          params = sanitizeOpenAICodexResponsesParams(
            model,
            params as Record<string, unknown>,
          ) as typeof params;
          params = sanitizeResponsesImagePayload(
            params as Record<string, unknown>,
          ) as typeof params;
          if (responsesOptions?.openclawCodeModeToolSurface === true) {
            const visibleToolNames = resolveCodeModeResponsesVisibleToolNames(context);
            const allowedHostedToolTypes = responsesOptions?.openclawCodeModeAllowedHostedToolTypes;
            enforceCodeModeResponsesToolSurface(
              params,
              visibleToolNames,
              allowedHostedToolTypes,
              codeModeToolSurfaceObserver.get(options),
            );
            assertCodeModeResponsesToolSurface(params, visibleToolNames, allowedHostedToolTypes);
          }
          if (
            asyncToolExecutionEligible &&
            params.model === "gpt-6-astra" &&
            params.multi_agent?.enabled !== true &&
            params.tools
          ) {
            const synchronousTools = new Set(
              context.tools?.flatMap((tool) => (tool.async === false ? [tool.name] : [])),
            );
            params.tools = params.tools.map((tool) =>
              tool.type === "function" && !synchronousTools.has(tool.name)
                ? { ...tool, async: true }
                : tool,
            );
          }
          return params;
        };
        const buildRequest = (replayMode: OpenAIResponsesReplayMode, requestContext = context) =>
          prepareRequest(
            config.buildRequest(
              model,
              requestContext,
              responsesOptions,
              turnState?.metadata,
              replayMode,
            ),
          );
        let params = await buildRequest("checkpoint");
        const asyncTools =
          asyncToolExecutionEligible &&
          params.model === "gpt-6-astra" &&
          params.multi_agent?.enabled !== true;
        if (compactRequest) {
          const compacted = await postOpenAIResponsesCompaction({
            client,
            model,
            request: params,
            options: responsesOptions,
          });
          output.usage.input = compacted.usage.input_tokens;
          output.usage.output = compacted.usage.output_tokens;
          output.usage.totalTokens = compacted.usage.input_tokens + compacted.usage.output_tokens;
          compactRequest.resolve(compacted);
          finalizeTransportStream({ stream, output, signal: options?.signal });
          return;
        }
        const sessionId = options?.sessionId;
        // Custom routes require an explicit capability; native routes retain
        // their existing eligibility and final request storage checks below.
        const httpContinuationEligible =
          config.httpContinuation &&
          !websocketMode &&
          !getAiTransportHost().requiresManagedTransport(model) &&
          (supportsNativeOpenAIResponsesEndpoint(model) ||
            resolveOpenAIResponsesPayloadPolicy(model).explicitContinuationOptIn);
        if (
          httpContinuationEligible &&
          sessionId &&
          (params.store === true || supportsResponsesReasoningUpdate(params)) &&
          !params.previous_response_id
        ) {
          const restoreRequest = () =>
            restoreResponsesReasoningState(context, model, responsesOptions, params);
          continuationClaim = claimOpenAIResponsesHttpContinuation({
            sessionId,
            apiKey,
            baseUrl: model.baseUrl,
            headers: httpHeaders,
            request: params as ResponsesContinuationRequest,
            restoreRequest,
          });
          // Persisted effort controls still apply when another request owns the cache.
          params = (continuationClaim?.fullRequest ?? restoreRequest()) as typeof params;
        }
        const observePrompt = createResponsesPromptEgressObserver(
          responsesOptions,
          context.systemPrompt,
        );
        const requestStartedAt = Date.now();
        let started = false;
        const startStream = () => {
          if (!started) {
            started = true;
            stream.push({ type: "start", partial: output });
          }
        };
        const firstEvent = createFirstStreamEventAbortController(options?.signal);
        firstEventAbort = firstEvent;
        const requestOptions = buildOpenAISdkRequestOptions(model, firstEvent.signal, {
          stream: config.streamRequest,
          timeoutMs: options?.timeoutMs,
        });
        const websocketSignal = combineWebSocketTimeoutSignal(
          firstEvent.signal,
          model,
          requestOptions?.timeout,
        );
        emitModelTransportDebug(
          log,
          `[responses] start provider=${model.provider} api=${model.api} model=${model.id} ` +
            `requestIdHash=${redactIdentifier(options?.requestId, { len: 64 })} ` +
            `baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} ` +
            `apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`,
        );
        const responseModelTracker = createResponseModelTracker(isOpenAICodexResponsesModel(model));
        let continuationBaseline: ResponsesContinuationRequest | undefined;
        let dispatchedPreviousResponseId: string | undefined;
        let contextUsageEligible = true;
        let requestedTier: unknown;
        const createSseStream = async (
          initialRequest = (continuationClaim?.request ?? params) as typeof params,
          initialAttemptKind: NonNullable<ResponsesStreamParams["initialAttemptKind"]> = "initial",
          initialRejectedCompaction?: ResponsesStreamParams["initialRejectedCompaction"],
        ): Promise<AsyncIterable<unknown>> => {
          const { stream: responseStream } = await createResponsesStreamWithRecovery({
            client,
            request: initialRequest,
            requestOptions,
            model,
            encodeBody,
            observePrompt,
            initialAttemptKind,
            initialRejectedCompaction,
            buildFullHistoryRequest: () => buildRequest("full-history"),
            onCompactionRejected: (checkpoint) =>
              suppressOpenAIResponsesCompaction(output, model, responsesOptions, checkpoint),
            canRetryStream: () => output.content.length === 0,
            onServiceTierRejected: (tier) => responsesServiceTierObserver.reject(options, tier),
            wrapStream: ({ stream: rawResponseStream, response, attempt }) => {
              requestedTier = attempt.request.service_tier;
              contextUsageEligible &&= attempt.kind === "initial";
              dispatchedPreviousResponseId = attempt.request.previous_response_id;
              continuationBaseline = attempt.request.previous_response_id
                ? (params as ResponsesContinuationRequest)
                : (attempt.request as ResponsesContinuationRequest);
              const trackedResponseStream = responseModelTracker.track(response, rawResponseStream);
              return withProviderResponseHook({
                stream: observeResponsesStream(trackedResponseStream, model, requestStartedAt),
                signal: firstEvent.signal,
                abort: firstEvent.abort,
                hook: createOpenAIProviderAcceptanceHook(options, response, model),
                onReady: () => {
                  emitModelTransportDebug(
                    log,
                    `[responses] headers provider=${model.provider} api=${model.api} model=${model.id} ` +
                      `transport=sse elapsedMs=${Date.now() - requestStartedAt}`,
                  );
                  startStream();
                },
              });
            },
          });
          return responseStream;
        };

        let responseStream: AsyncIterable<unknown>;
        let websocketBaseline: ResponsesContinuationRequest | undefined;
        let finishWebSocket: ((options?: { keep?: boolean }) => void) | undefined;
        let transport: "sse" | "websocket" = "sse";
        const logWebSocketFallback = (reason: string) =>
          emitModelTransportDebug(
            log,
            `[responses] websocket_fallback provider=${model.provider} api=${model.api} ` +
              `model=${model.id} reason=${reason}`,
          );
        const closeWebSocketForFallback = (reason: string) => {
          finishWebSocket?.({ keep: false });
          finishWebSocket = undefined;
          transport = "sse";
          logWebSocketFallback(reason);
        };
        if (websocketMode) {
          try {
            const websocket = createOpenAIResponsesWebSocketStream({
              client,
              request: params,
              restoreRequest: (request) =>
                restoreResponsesReasoningState(context, model, responsesOptions, request),
              mode: websocketMode,
              sessionId: options?.sessionId,
              headers: websocketHeaders,
              signal: websocketSignal,
              callerSignal: options?.signal,
              degradeCooldownMs: websocketSessionPolicy?.degradeCooldownMs,
              onActiveResponse:
                nativeAstra && params.model === "gpt-6-astra"
                  ? options?.onActiveResponse
                  : undefined,
              steeringInput: (messages) => {
                contextUsageEligible = false;
                return projectResponsesSteeringInput(params, () =>
                  buildRequest("checkpoint", {
                    ...context,
                    messages: [...context.messages, ...messages],
                  }),
                );
              },
            });
            finishWebSocket = websocket.finish;
            requestedTier = websocket.request.service_tier;
            websocketBaseline = websocket.fullRequest;
            recordResponsesInputReplay(output, websocket.inputReplay);
            contextUsageEligible &&= websocket.inputReplay === undefined;
            observePrompt?.(websocket.request, {
              egress: "responses-websocket",
              payloadVariant: "initial",
            });
            transport = "websocket";
            emitModelTransportDebug(
              log,
              `[responses] websocket_selected provider=${model.provider} api=${model.api} model=${model.id} ` +
                `mode=${websocketMode} reused=${websocket.reusedConnection} ` +
                `continuation=${websocket.continuationStatus === "continued"} continuationStatus=${websocket.continuationStatus} ` +
                `sessionIdHash=${redactIdentifier(options?.sessionId)} ` +
                `headersHash=${redactIdentifier(JSON.stringify(Object.entries(websocketHeaders ?? {}).toSorted(([a], [b]) => a.localeCompare(b))))}`,
            );
            responseStream = createRecoverableResponsesWebSocketStream({
              trackedWebSocketStream: responseModelTracker.track(undefined, websocket.stream),
              websocket,
              websocketSignal,
              options,
              output,
              buildRequest,
              createSseStream,
              closeWebSocketForFallback,
              logWebSocketFallback,
              startStream,
              setTransportToSse: () => {
                transport = "sse";
              },
            });
          } catch (error) {
            if (error instanceof OpenAIResponsesWebSocketPostDispatchError) {
              throw error;
            }
            closeWebSocketForFallback("setup_failure");
            responseStream = await createSseStream();
          }
        } else {
          responseStream = await createSseStream();
        }
        try {
          const acceptedResponseStream = withResponsesRequestAcceptance(
            responseStream,
            requestLifecycle,
            transport === "websocket" ? websocketSignal : firstEvent.signal,
          );
          const terminal = await processResponsesStream(
            acceptedResponseStream,
            output,
            stream,
            model,
            {
              canRetryIdentityConflict: () =>
                hasOnlyResponsesFunctionTools(
                  transport === "websocket" ? websocketBaseline : continuationBaseline,
                ),
              ...config.pricingOptions?.(responsesOptions, model),
              resolveServiceTier: (responseTier, originalTier) =>
                responseTier ??
                (requestedTier === "priority" || requestedTier === "default"
                  ? requestedTier
                  : originalTier),
              onServiceTier: (responseTier) =>
                responsesServiceTierObserver.observe(options, requestedTier, responseTier),
              firstEventTimeoutMs:
                getFirstStreamEventTimeoutMs(options) ?? config.firstEventTimeoutMs,
              abortFirstEventStream: firstEvent.abort,
              onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
              signal: options?.signal,
              reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
                authProfileId: responsesOptions?.authProfileId,
                sessionId: options?.sessionId,
              }),
              asyncToolExecution: asyncTools,
              ...responseModelTracker.terminalOptions,
            },
          );
          finishWebSocket?.();
          if (options?.signal?.aborted) {
            throw transportAbortError(options.signal);
          }
          if (output.stopReason === "aborted" || output.stopReason === "error") {
            // Keep the provider's terminal fact; the catch-side projection would overwrite it.
            throw new Error(output.errorMessage ?? "An unknown error occurred");
          }
          const admitted = transport === "websocket" ? websocketBaseline : continuationBaseline;
          if (terminal && admitted && supportsNativeOpenAIResponsesEndpoint(model)) {
            recordResponsesReasoningState(
              output,
              model,
              responsesOptions,
              admitted,
              terminal.output,
            );
          }
          if (continuationClaim && continuationBaseline && terminal) {
            continuationClaim.commit(continuationBaseline, terminal, dispatchedPreviousResponseId);
          }
          if (terminal && admitted && contextUsageEligible) {
            recordResponsesContextUsage(
              output,
              model,
              responsesOptions,
              admitted,
              terminal.output,
              "transport",
            );
          }
        } catch (error) {
          finishWebSocket?.({ keep: false });
          throw error;
        }
        emitModelTransportDebug(
          log,
          `[responses] completed provider=${model.provider} api=${model.api} model=${model.id} ` +
            `transport=${transport} elapsedMs=${Date.now() - requestStartedAt}`,
        );
        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error) {
        if (requestLifecycle) {
          await requestLifecycle.settle().catch(() => undefined);
        }
        if (compactRequest) {
          compactRequest.reject(error);
          failTransportStream({ stream, output, signal: options?.signal, error });
          return;
        }
        if (error instanceof ResponsesStreamFailure && error.observation) {
          logResponsesFailedNoDetails(error.observation);
        }
        const incompleteReason = output.diagnostics?.find(
          ({ type }) => type === "openai_responses_terminal",
        )?.details?.incompleteReason;
        emitModelTransportError(
          log,
          "responses",
          `provider=${model.provider} api=${model.api} model=${model.id} ` +
            summarizeOpenAITransportError(error) +
            (typeof incompleteReason === "string" ? ` incompleteReason=${incompleteReason}` : ""),
          options?.signal,
        );
        failTransportStream({ stream, output, signal: options?.signal, error });
      } finally {
        continuationClaim?.release();
        firstEventAbort?.dispose();
      }
    })();
    return eventStream;
  };
}

export function createOpenAIResponsesTransportStreamFn(): StreamFn {
  return createResponsesTransportExecutor({
    streamRequest: true,
    httpContinuation: true,
    createClient: createOpenAIResponsesClient,
    buildRequest: buildOpenAIResponsesParams,
    pricingOptions: (options, model) => ({
      serviceTier: options?.serviceTier,
      // One canonical service-tier pricing table; a transport-local copy drifted
      // from provider pricing (gpt-5.5 priority 2.5x) and understated costs.
      applyServiceTierPricing: (usage, serviceTier) =>
        applyResponsesServiceTierPricing(usage, serviceTier, model),
    }),
  });
}

export function createAzureOpenAIResponsesTransportStreamFn(): StreamFn {
  return createResponsesTransportExecutor({
    outputApi: "azure-openai-responses",
    firstEventTimeoutMs: AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
    createClient: createAzureOpenAIClient,
    buildRequest: (model, context, options, metadata, replayMode) => {
      const deploymentName = resolveAzureDeploymentNameFromMap({
        modelId: model.id,
        deploymentMap: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP,
      });
      const params = buildOpenAIResponsesParams(model, context, options, metadata, replayMode);
      params.model = deploymentName;
      delete params.store;
      return params;
    },
  });
}

function createAzureOpenAIClient(
  model: Model,
  apiKey: string,
  defaultHeaders: Record<string, string>,
  fetchOverride?: typeof globalThis.fetch,
) {
  const baseURL = model.baseUrl.replace(/\/+$/, "");
  const clientOptions = {
    apiKey,
    dangerouslyAllowBrowser: true,
    defaultHeaders,
    baseURL,
    fetch: fetchOverride ?? buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  };

  if (isOpenAICompatibleAzureResponsesBaseUrl(baseURL)) {
    return new OpenAI(clientOptions);
  }

  return new AzureOpenAI({
    ...clientOptions,
    apiVersion: resolveAzureOpenAIApiVersion(),
  });
}
