import type * as NodeOs from "node:os";
import type * as NodeZlib from "node:zlib";
import { consumeResponseBytes } from "@openclaw/normalization-core";
import {
  extractErrorCodeOrErrno,
  toErrorObject,
} from "@openclaw/normalization-core/error-coercion";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import {
  getAiTransportHost,
  resolveAiTransportHeaderSentinels,
  type AiTransportHost,
} from "../host.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import { buildManagedModelFetch } from "../transports/host-policy.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
  type OpenAIResponsesReplayMode,
} from "../transports/openai-responses-compaction-replay.js";
import { recordResponsesContextUsage } from "../transports/openai-responses-context-usage.js";
import { responsesPromptObserver } from "../transports/openai-responses-contracts.js";
import { ResponsesStreamFailure } from "../transports/openai-responses-debug.js";
import { createResponsesPromptEgressObserver } from "../transports/openai-responses-prompt-observer-internal.js";
import {
  commitResponsesEncryptedContentAttempt,
  isInvalidEncryptedContentError,
  resolveNextResponsesEncryptedContentAttempt,
  type ResponsesEncryptedContentAttempt,
} from "../transports/openai-responses-replay-internal.js";
import { responsesRequestLifecycle } from "../transports/openai-responses-request-lifecycle.js";
import { processResponsesStream } from "../transports/openai-responses-stream-internal.js";
import type { CompletedResponse } from "../transports/openai-responses-stream-types-internal.js";
import {
  createOpenAIProviderAcceptanceHook,
  createOpenAIResponseHook,
} from "../transports/openai-transport-shared.js";
import {
  assignTransportErrorDetails,
  notifyProviderStreamOpened,
  transportAbortError,
  withProviderResponseHook,
} from "../transports/transport-stream-shared.js";
import {
  MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
  parseRetryAfterSeconds,
} from "../transports/transport-utils.js";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "../types.js";
import {
  appendAssistantMessageDiagnostic,
  createAssistantMessageDiagnostic,
  formatThrownValue,
  type ProviderRefusalReview,
} from "../utils/diagnostics.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { resolveOpenAICodexAccountId } from "../utils/oauth/openai-chatgpt-jwt.js";
import { requireApiKey } from "../utils/required-api-key.js";
import { WEBSOCKET_NON_RETRYABLE_CLOSE_ERROR_CODE } from "../utils/retryable-network-errors.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  withFirstStreamEventTimeout,
} from "../utils/stream-first-event-timeout.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import { CodexApiError, mapCodexEvents } from "./openai-chatgpt-responses-events.js";
import {
  CodexProtocolError,
  parseOpenAIChatGptResponsesSse,
  resolveCodexUrl,
} from "./openai-chatgpt-responses-protocol.js";
import {
  addCodexWebSocketSseFallback,
  buildCodexWebSocketHeaders,
  hasCodexWebSocketSseFallback,
  matchesCodexWebSocketAuthority,
  resolveCodexWebSocketAuthority,
  type CodexWebSocketAuthority,
} from "./openai-chatgpt-responses-websocket-authority.js";
import {
  closeAllOpenAICodexWebSocketStates,
  closeOpenAICodexWebSocketState,
  closeWebSocketSilently,
  deleteOwnedWebSocketSession,
  getOpenAICodexWebSocketRuntimeState,
  isWebSocketReusable,
  isWebSocketSessionExpired,
  scheduleSessionWebSocketExpiry,
  setOwnedWebSocketSession,
  type CachedWebSocketConnection,
  type OpenAICodexWebSocketRuntimeState,
  type RequestBody,
  type WebSocketLike,
  type WebSocketListener,
} from "./openai-chatgpt-responses-websocket-state.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import { readOpenAIMisalignmentReview } from "./openai-provider-refusal.js";
import { supportsOpenAITemperature } from "./openai-reasoning-effort.js";
import {
  resolveOpenAISimpleReasoningEffort,
  resolveOpenAIRequestReasoning,
  type OpenAIRequestReasoningEffort,
} from "./openai-request-reasoning.js";
import { resolveOpenAIResponsesTextFormat } from "./openai-response-format.js";
import {
  applyResponsesServiceTierPricing,
  convertResponsesMessages,
  convertResponsesToolPayload,
  createResponsesAssistantOutput,
} from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);

type ProcessWithOsBuiltinModule = typeof process & {
  getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return null;
  }
  return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
const os = loadNodeOs();

const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "opencode"]);
const WEBSOCKET_TRANSPORT_ERROR_CODE = "ERR_WEBSOCKET_TRANSPORT";
// Only registered server/transport-unavailability closes may authorize retry or
// settled-turn finalization; peer policy/protocol rejections must fail closed.
const RETRYABLE_WEBSOCKET_CLOSE_CODES = new Set([1001, 1005, 1006, 1011, 1012, 1013, 1014, 1015]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const WEBSOCKET_REPLAY_REJECTION =
  "Codex error: Persisted response contains hosted-tool, compaction, or unverifiable hidden reasoning state that Rustponses cannot replay. Start a new response or use the Python Responses service for this continuation.";
const OPENAI_CHATGPT_RESPONSES_ERROR_BODY_MAX_BYTES = 16 * 1024;

interface OpenAICodexResponsesOptions extends BaseOpenAIStreamOptions {
  reasoningEffort?: OpenAIRequestReasoningEffort;
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  textVerbosity?: "low" | "medium" | "high";
}

type ObserveResponsesPromptEgress = NonNullable<
  ReturnType<typeof createResponsesPromptEgressObserver>
>;
type ProcessCodexStream = (
  events: AsyncIterable<unknown>,
  options?: OpenAICodexResponsesOptions,
  activitySignal?: AbortSignal,
) => ReturnType<typeof processResponsesStream>;

function isRequestTimeoutError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): boolean {
  if (timeoutMs === undefined || callerSignal?.aborted || !requestSignal?.aborted) {
    return false;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.message === "Request was aborted"
  );
}

type StreamFailureKind = "timeout" | "caller-abort" | "provider-failure" | "transport";

/** Local-only failure category for transport diagnostics; never provider text. */
function classifyStreamFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  requestTimedOut: boolean,
): StreamFailureKind {
  if (requestTimedOut) {
    return "timeout";
  }
  if (signal?.aborted) {
    return "caller-abort";
  }
  // CodexApiError carries a non-OK HTTP reply; both are provider decisions, not transport faults.
  return error instanceof ResponsesStreamFailure || error instanceof CodexApiError
    ? "provider-failure"
    : "transport";
}

function formatRequestTimeoutError(timeoutMs: number, cause: unknown): Error {
  return new Error(`Request timed out after ${timeoutMs}ms`, {
    cause: cause instanceof Error ? cause : undefined,
  });
}

type ProcessWithZlibBuiltinModule = typeof process & {
  getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

function compressRequestBodyZstd(bodyJson: string): Uint8Array<ArrayBuffer> | null {
  if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
    return null;
  }
  const zlib = (process as ProcessWithZlibBuiltinModule).getBuiltinModule?.("node:zlib");
  if (!zlib || typeof zlib.zstdCompressSync !== "function") {
    return null;
  }
  try {
    const compressed = zlib.zstdCompressSync(bodyJson, {
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL,
      },
    });
    return Uint8Array.from(compressed);
  } catch {
    return null;
  }
}

export const streamOpenAICodexResponses: StreamFunction<
  "openai-chatgpt-responses",
  OpenAICodexResponsesOptions
> = (model, context, options) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const startedAt = Date.now();
    let requestTimeoutMs: number | undefined;
    let requestTimeoutSignal: AbortSignal | undefined;
    let activeSignal: AbortSignal | undefined;
    let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
    const output = createResponsesAssistantOutput(model);

    try {
      const unresolvedApiKey = requireApiKey(model.provider, options?.apiKey);
      // WebSocket auth has no fetch seam; unwrap immediately before request construction.
      const transportHost = getAiTransportHost();
      const websocketState = getOpenAICodexWebSocketRuntimeState(transportHost);
      const apiKey = transportHost.resolveSecretSentinel(unresolvedApiKey);
      const modelHeaders = resolveAiTransportHeaderSentinels(model.headers);
      const optionHeaders = resolveAiTransportHeaderSentinels(options?.headers);

      const accountId = extractOpenAICodexAccountId(apiKey);
      const buildBody = async (replayMode: OpenAIResponsesReplayMode) => {
        let body = buildRequestBody(model, context, options, replayMode);
        const nextBody = await options?.onPayload?.(body, model);
        if (nextBody !== undefined) {
          body = nextBody as RequestBody;
        }
        return body;
      };
      let semanticAttempt: ResponsesEncryptedContentAttempt<RequestBody> = {
        kind: "initial",
        request: await buildBody("checkpoint"),
      };
      const commitSemanticAttempt = (attempt: ResponsesEncryptedContentAttempt<RequestBody>) =>
        commitResponsesEncryptedContentAttempt(attempt, (checkpoint) =>
          suppressOpenAIResponsesCompaction(output, model, options, checkpoint),
        );
      const observePromptEgress = createResponsesPromptEgressObserver(
        options,
        context.systemPrompt,
      );
      // Without a session id, each WebSocket request gets independent affinity.
      const sessionId = clampOpenAIPromptCacheKey(options?.sessionId);
      requestTimeoutMs = clampPositiveTimerTimeoutMs(options?.timeoutMs);
      requestTimeoutSignal = options?.signal;
      if (requestTimeoutMs !== undefined) {
        const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
        requestTimeoutSignal = options?.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
      }
      firstEventAbort = createFirstStreamEventAbortController(requestTimeoutSignal);
      activeSignal = firstEventAbort.signal;
      const requestOptions =
        activeSignal === options?.signal ? options : { ...options, signal: activeSignal };
      const processStream: ProcessCodexStream = (events, streamOptions, activitySignal) =>
        processResponsesStream(events, output, stream, model, {
          serviceTier: streamOptions?.serviceTier,
          firstEventTimeoutMs: getFirstStreamEventTimeoutMs(streamOptions),
          abortFirstEventStream: firstEventAbort?.abort,
          onFirstEventTimeout: getFirstStreamEventTimeoutHandler(streamOptions),
          // Activity belongs to the caller signal, not the request-scoped abort composite.
          signal: activitySignal ?? streamOptions?.signal,
          reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
            sessionId: streamOptions?.sessionId,
            authProfileId: streamOptions?.authProfileId,
          }),
          resolveServiceTier: resolveCodexServiceTier,
          applyServiceTierPricing: (usage, serviceTier) =>
            applyResponsesServiceTierPricing(usage, serviceTier, model),
        });
      const completeStream = (
        terminal: CompletedResponse | null | undefined,
        attempt: ResponsesEncryptedContentAttempt<RequestBody>,
        ErrorType: new (message: string) => Error,
      ) => {
        if (activeSignal?.aborted) {
          throw transportAbortError(activeSignal);
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new ErrorType(output.errorMessage ?? "An unknown error occurred");
        }
        if (terminal && attempt.kind === "initial") {
          recordResponsesContextUsage(
            output,
            model,
            options,
            attempt.request,
            terminal.output,
            "provider",
          );
        }
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        stream.end();
      };
      const transport = options?.transport || "auto";
      let websocketAuthority: CodexWebSocketAuthority | undefined;
      if (!transportHost.requiresManagedTransport(model)) {
        try {
          websocketAuthority = resolveCodexWebSocketAuthority({
            transport,
            transportHost,
            baseUrl: model.baseUrl,
            headers: () =>
              buildCodexWebSocketHeaders(
                buildBaseCodexHeaders(modelHeaders, optionHeaders, accountId, apiKey),
                sessionId || createCodexRequestId(),
              ),
          });
        } catch (error) {
          if (transport !== "auto") {
            throw error;
          }
          appendAssistantMessageDiagnostic(
            output,
            createAssistantMessageDiagnostic("provider_transport_failure", error, {
              configuredTransport: transport,
              fallbackTransport: "sse",
              eventsEmitted: false,
              phase: "before_message_stream_start",
            }),
          );
        }
      }
      const websocketDisabledForSession =
        transport === "auto" &&
        websocketAuthority !== undefined &&
        hasCodexWebSocketSseFallback(
          websocketState.sseFallbacks,
          options?.sessionId,
          websocketAuthority,
        );

      if (websocketAuthority && !websocketDisabledForSession) {
        let websocketStarted = false;
        let retriedWebSocketRejection = false;
        while (true) {
          const activeAttempt = semanticAttempt;
          const dispatch: { request?: RequestBody } = {};
          websocketStarted = false;
          try {
            const terminal = await processWebSocketStream(
              websocketState,
              websocketAuthority,
              activeAttempt.request,
              output,
              stream,
              model,
              () => {
                websocketStarted = true;
              },
              () => {
                commitSemanticAttempt(activeAttempt);
              },
              requestOptions,
              processStream,
              observePromptEgress,
              activeAttempt.kind,
              (request) => {
                dispatch.request = request;
              },
              options?.signal,
            );
            completeStream(terminal, activeAttempt, CodexApiError);
            return;
          } catch (error) {
            const aborted = activeSignal?.aborted;
            // Observer and local send failures happen before dispatch and must not
            // be classified as provider rejection of encrypted replay state.
            const nextSemanticAttempt =
              !aborted &&
              dispatch.request &&
              !websocketStarted &&
              error instanceof CodexApiError &&
              isInvalidEncryptedContentError(error)
                ? await resolveNextResponsesEncryptedContentAttempt(activeAttempt, error, {
                    buildFullHistoryRequest: () => buildBody("full-history"),
                  })
                : undefined;
            if (nextSemanticAttempt) {
              semanticAttempt = nextSemanticAttempt;
              retriedWebSocketRejection = false;
              continue;
            }
            // Releasing the rejected socket discards its continuation. Retry the
            // retained full input, including completed tools, without stripping state.
            const reconnectBeforeStart =
              !websocketStarted &&
              (isWebSocketConnectionLimitReachedError(error) ||
                (dispatch.request?.previous_response_id &&
                  error instanceof CodexApiError &&
                  error.message === WEBSOCKET_REPLAY_REJECTION));
            if (!aborted && reconnectBeforeStart && !retriedWebSocketRejection) {
              retriedWebSocketRejection = true;
              continue;
            }
            // After output starts, the runner must continue the transcript instead of replaying.
            const transportError = isWebSocketConnectionLimitReachedError(error)
              ? Object.assign(new Error(error.message, { cause: error }), {
                  code: WEBSOCKET_TRANSPORT_ERROR_CODE,
                })
              : error;
            if (aborted || isCodexNonTransportError(transportError)) {
              throw transportError;
            }
            appendAssistantMessageDiagnostic(
              output,
              createAssistantMessageDiagnostic("provider_transport_failure", transportError, {
                configuredTransport: transport,
                fallbackTransport: transport === "auto" && !websocketStarted ? "sse" : undefined,
                eventsEmitted: websocketStarted,
                phase: websocketStarted
                  ? "after_message_stream_start"
                  : "before_message_stream_start",
                requestBytes: new TextEncoder().encode(JSON.stringify(activeAttempt.request))
                  .byteLength,
              }),
            );
            if (transport === "auto" && options?.sessionId) {
              addCodexWebSocketSseFallback(
                websocketState.sseFallbacks,
                options.sessionId,
                websocketAuthority,
              );
            }
            if (websocketStarted || transport !== "auto") {
              throw transportError;
            }
            break;
          }
        }
      }

      let response: Response | undefined;
      while (true) {
        const activeAttempt = semanticAttempt;
        response = undefined;
        const sseHeaders = buildSSEHeaders(
          modelHeaders,
          optionHeaders,
          accountId,
          apiKey,
          sessionId,
        );
        const bodyJson = JSON.stringify(activeAttempt.request);
        const canCompressSseBody =
          model.provider === "openai" && !sseHeaders.has("content-encoding");
        const compressedBody = canCompressSseBody ? compressRequestBodyZstd(bodyJson) : null;
        if (compressedBody) {
          sseHeaders.set("content-encoding", "zstd");
        }
        const sseBody: BodyInit = compressedBody ?? bodyJson;

        if (activeSignal?.aborted) {
          throw transportAbortError(activeSignal);
        }
        observePromptEgress?.(activeAttempt.request, {
          egress: "native-codex-sse",
          payloadVariant: activeAttempt.kind,
        });

        let attemptResponse: Response;
        try {
          const lifecycle = responsesRequestLifecycle.get(options);
          if (lifecycle) {
            await lifecycle.beforeDispatch(activeSignal);
            activeSignal?.throwIfAborted();
            lifecycle.assertCurrent();
          }
          attemptResponse = await (buildManagedModelFetch(model, transportHost) ?? fetch)(
            resolveCodexUrl(model.baseUrl),
            {
              method: "POST",
              headers: sseHeaders,
              body: sseBody,
              signal: activeSignal,
            },
          );
        } catch (error) {
          if (error instanceof Error) {
            if (
              isRequestTimeoutError(
                error,
                options?.signal,
                requestTimeoutSignal,
                requestTimeoutMs,
              ) &&
              requestTimeoutMs !== undefined
            ) {
              throw formatRequestTimeoutError(requestTimeoutMs, error);
            }
            if (error.name === "AbortError" || error.message === "Request was aborted") {
              throw new Error("Request was aborted", { cause: error });
            }
            if (error.name === "TimeoutError" && requestTimeoutMs !== undefined) {
              throw new Error(`Request timed out after ${requestTimeoutMs}ms`, { cause: error });
            }
          }
          throw toErrorObject(error, String(error));
        }

        response = attemptResponse;
        if (attemptResponse.ok) {
          if (!attemptResponse.body) {
            throw new Error("No response body");
          }
          if (activeSignal?.aborted) {
            throw transportAbortError(activeSignal);
          }
          commitSemanticAttempt(activeAttempt);
          break;
        }

        const hookStream = withFirstStreamEventTimeout(
          withProviderResponseHook({
            signal: firstEventAbort.signal,
            abort: firstEventAbort.abort,
            hook: createOpenAIResponseHook(options?.onResponse, attemptResponse, model),
          }),
          {
            provider: model.provider,
            api: model.api,
            model: model.id,
            timeoutMs: getFirstStreamEventTimeoutMs(options) ?? 0,
            stage: "responses",
            abort: firstEventAbort.abort,
            onTimeout: getFirstStreamEventTimeoutHandler(options),
          },
        );
        const [errorText] = await Promise.all([
          readChatGptResponsesErrorTextLimited(attemptResponse, activeSignal),
          hookStream[Symbol.asyncIterator]().next(),
        ]);
        const terminalResponseError = parseErrorResponse(errorText, attemptResponse);
        if (activeSignal?.aborted) {
          throw transportAbortError(activeSignal);
        }
        const nextSemanticAttempt = await resolveNextResponsesEncryptedContentAttempt(
          activeAttempt,
          terminalResponseError,
          { buildFullHistoryRequest: () => buildBody("full-history") },
        );
        if (!nextSemanticAttempt) {
          throw terminalResponseError;
        }
        semanticAttempt = nextSemanticAttempt;
      }

      const hookedResponseStream = withProviderResponseHook({
        stream: mapCodexEvents(
          parseOpenAIChatGptResponsesSse(response),
          response.headers,
          requestOptions,
        ),
        signal: firstEventAbort.signal,
        abort: firstEventAbort.abort,
        hook: createOpenAIProviderAcceptanceHook(options, response, model),
        onReady: () => stream.push({ type: "start", partial: output }),
      });
      const terminal = await processStream(hookedResponseStream, options);
      completeStream(terminal, semanticAttempt, Error);
    } catch (error) {
      // A timeout can detach the iterator while its acceptance write is still settling.
      await responsesRequestLifecycle
        .get(options)
        ?.settle()
        .catch(() => undefined);
      const requestTimedOut =
        isRequestTimeoutError(error, options?.signal, requestTimeoutSignal, requestTimeoutMs) &&
        requestTimeoutMs !== undefined;
      const normalizedError =
        requestTimedOut && requestTimeoutMs !== undefined
          ? formatRequestTimeoutError(requestTimeoutMs, error)
          : error;
      for (const block of output.content) {
        // partialJson is only a streaming scratch buffer; never persist it.
        delete (block as { partialJson?: string }).partialJson;
      }
      const providerRefusal = readCodexProviderRefusal(normalizedError);
      if (providerRefusal) {
        appendAssistantMessageDiagnostic(output, {
          type: "provider_refusal",
          timestamp: Date.now(),
          details: {
            provider: "openai",
            category: providerRefusal.category,
            ...(providerRefusal.review ? { review: providerRefusal.review } : {}),
          },
        });
      }
      const terminal = assignTransportErrorDetails(output, normalizedError, options?.signal);
      // Log only locally-derived facts: timing and a fixed failure category. No
      // projected provider field (message, body, code, type, name) is logged —
      // all of them are provider-controlled text that can carry prompt- or
      // response-derived content.
      getAiTransportHost().logWarn("openai-transport", "ChatGPT Responses stream terminated", {
        provider: model.provider,
        api: model.api,
        model: model.id,
        transport: options?.transport || "auto",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        stopReason: terminal.stopReason,
        failureKind: classifyStreamFailure(error, options?.signal, requestTimedOut),
      });
      stream.push({ type: "error", reason: terminal.stopReason, error: output });
      stream.end();
    } finally {
      firstEventAbort?.dispose();
    }
  })();

  return stream;
};

export const streamSimpleOpenAICodexResponses: StreamFunction<
  "openai-chatgpt-responses",
  SimpleStreamOptions
> = (model, context, options) => {
  const apiKey = requireApiKey(model.provider, options?.apiKey);

  const resolvedOptions = {
    ...buildBaseOptions(model, options, apiKey),
    authProfileId: (options as (SimpleStreamOptions & { authProfileId?: string }) | undefined)
      ?.authProfileId,
    reasoningEffort: resolveOpenAISimpleReasoningEffort(model, options?.reasoning),
  } satisfies OpenAICodexResponsesOptions;
  responsesPromptObserver.copy(options, resolvedOptions);
  const lifecycle = responsesRequestLifecycle.get(options);
  if (lifecycle) {
    responsesRequestLifecycle.set(resolvedOptions, lifecycle);
  }
  return streamOpenAICodexResponses(model, context, resolvedOptions);
};

function buildRequestBody(
  model: Model<"openai-chatgpt-responses">,
  context: Context,
  options?: OpenAICodexResponsesOptions,
  replayMode: OpenAIResponsesReplayMode = "checkpoint",
): RequestBody {
  const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
    replayResponsesItemIds: false,
    sessionId: options?.sessionId,
    authProfileId: options?.authProfileId,
    replayMode,
  });

  const body: RequestBody = {
    model: model.id,
    store: false,
    stream: true,
    instructions:
      stripSystemPromptCacheBoundary(context.systemPrompt ?? "") || "You are a helpful assistant.",
    input: messages,
    text: { verbosity: options?.textVerbosity || "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key:
      options?.cacheRetention === "none"
        ? undefined
        : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId),
  };

  if (options?.responseFormat !== undefined) {
    body.text = {
      ...body.text,
      format: resolveOpenAIResponsesTextFormat(options.responseFormat),
    };
  }

  if (options?.temperature !== undefined && supportsOpenAITemperature(model)) {
    body.temperature = options.temperature;
  }

  if (options?.serviceTier !== undefined) {
    body.service_tier = options.serviceTier;
  }

  if (context.tools) {
    // Explicit false prevents the backend from normalizing optional properties into required ones.
    const tools = convertResponsesToolPayload(context.tools, { strict: false });
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }
  }

  const effort =
    options?.reasoningEffort === undefined
      ? undefined
      : resolveOpenAIRequestReasoning(model, options.reasoningEffort).effort;
  if (effort !== undefined) {
    body.reasoning = {
      effort,
      ...(effort === "none" ? {} : { summary: options?.reasoningSummary ?? "auto" }),
    };
  }

  return body;
}

function resolveCodexServiceTier(
  responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
  if (
    responseServiceTier === "default" &&
    (requestServiceTier === "flex" || requestServiceTier === "priority")
  ) {
    return requestServiceTier;
  }
  return responseServiceTier ?? requestServiceTier;
}

type CodexProviderRefusalCategory = "bio" | "cyber" | "misalignment";

/**
 * Structured refusal code carried by the OpenAI Responses transport. Every
 * terminal Responses path preserves it: a non-OK HTTP body parsed by
 * {@link parseErrorResponse}, an SSE/WebSocket `error` event mapped by
 * {@link mapCodexEvents}, and a `response.failed` event normalized into
 * {@link ResponsesStreamFailure}. Only the app-server surface carries the
 * `codexErrorInfo` discriminator, so both shapes must be read here.
 */
function readCodexProviderRefusal(
  error: unknown,
): { category: CodexProviderRefusalCategory; review?: ProviderRefusalReview } | undefined {
  if (!(error instanceof ResponsesStreamFailure || error instanceof CodexApiError)) {
    return undefined;
  }
  const payload =
    error instanceof CodexApiError
      ? error.payload
      : isRecord(error.response)
        ? error.response
        : undefined;
  const nested = isRecord(payload?.error) ? payload.error : undefined;
  const codexErrorInfo = payload?.codexErrorInfo ?? nested?.codexErrorInfo;
  if (error.code === "cyber_policy" || codexErrorInfo === "cyberPolicy") {
    return { category: "cyber" };
  }
  if (
    error.code === "misalignment_policy_violation" ||
    codexErrorInfo === "misalignmentPolicyViolation"
  ) {
    const details = nested?.misalignment ?? payload?.misalignment;
    const review = readOpenAIMisalignmentReview(details, true);
    return { category: "misalignment", ...(review ? { review } : {}) };
  }
  const message =
    typeof payload?.message === "string"
      ? payload.message
      : typeof nested?.message === "string"
        ? nested.message
        : "";
  return message.startsWith("This content was flagged for possible biological risk.")
    ? { category: "bio" }
    : undefined;
}

function isCodexNonTransportError(error: unknown): boolean {
  return (
    error instanceof CodexApiError ||
    error instanceof CodexProtocolError ||
    error instanceof ResponsesStreamFailure
  );
}

function isWebSocketConnectionLimitReachedError(error: unknown): error is CodexApiError {
  return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

let cachedWebsocket: WebSocketConstructor | null = null;

export function resetOpenAICodexWebSocketStateForTest(): void {
  cachedWebsocket = null;
}

export function closeOpenAICodexWebSocketSessions(
  sessionId?: string,
  owner?: AiTransportHost,
): void {
  if (owner) {
    closeOpenAICodexWebSocketState(owner, sessionId);
    return;
  }
  closeAllOpenAICodexWebSocketStates(sessionId);
}

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

async function getWebSocketConstructor(): Promise<WebSocketConstructor | null> {
  if (cachedWebsocket) {
    return cachedWebsocket;
  }

  // bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
  // Keep the fallback until Bun supports proxy envs in websocket.
  if (
    process?.versions?.bun &&
    (process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy)
  ) {
    const m = await dynamicImport("proxy-from-env");
    const getProxyForUrl = (m as { getProxyForUrl: (url: string | object | URL) => string })
      .getProxyForUrl;

    cachedWebsocket = class extends WebSocket {
      constructor(url: string | URL, options?: string | string[] | Record<string, unknown>) {
        let opts: Record<string, unknown>;
        if (Array.isArray(options) || typeof options === "string") {
          opts = { protocols: options };
        } else {
          opts = { ...options };
        }

        const proxy = getProxyForUrl(
          url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
        );
        super(url, { ...opts, ...(proxy ? { proxy } : {}) } as string | string[] | undefined);
      }
    };
    return cachedWebsocket;
  }

  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== "function") {
    return null;
  }
  return ctor as unknown as WebSocketConstructor;
}

function createWebSocketTransportError(message: string, cause?: Error): Error {
  // ErrorEvents can flatten the underlying socket failure. Preserve its code
  // when available and retain a stable producer fact when it is opaque.
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: extractErrorCodeOrErrno(cause) ?? WEBSOCKET_TRANSPORT_ERROR_CODE,
  });
}

async function connectWebSocket(
  url: string,
  headers: Headers,
  signal?: AbortSignal,
): Promise<WebSocketLike> {
  const WebSocketCtor = await getWebSocketConstructor();
  if (!WebSocketCtor) {
    throw new Error("WebSocket transport is not available in this runtime");
  }

  const wsHeaders = headersToRecord(headers);
  delete wsHeaders["OpenAI-Beta"];

  return new Promise<WebSocketLike>((resolve, reject) => {
    let settled = false;
    let socket: WebSocketLike;

    try {
      socket = new WebSocketCtor(url, { headers: wsHeaders });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const settle = (error?: Error, aborted = false) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (aborted) {
        socket.close(1000, "aborted");
      }
      if (error) {
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onOpen: WebSocketListener = () => settle();
    const onError: WebSocketListener = (event) => settle(extractWebSocketError(event));
    const onClose: WebSocketListener = (event) => settle(extractWebSocketCloseError(event));
    const onAbort = () => settle(new Error("Request was aborted"), true);

    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
  });
}

async function acquireWebSocket(
  state: OpenAICodexWebSocketRuntimeState,
  authority: CodexWebSocketAuthority,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<{
  socket: WebSocketLike;
  entry?: CachedWebSocketConnection;
  release: (options?: { keep?: boolean }) => void;
}> {
  const { url, headers } = authority;
  const lease = (socket: WebSocketLike, entry?: CachedWebSocketConnection) => ({
    socket,
    entry,
    release: ({ keep }: { keep?: boolean } = {}) => {
      if (!sessionId || !entry || !keep || !isWebSocketReusable(socket)) {
        closeWebSocketSilently(socket);
        if (entry?.idleTimer) {
          clearTimeout(entry.idleTimer);
        }
        if (sessionId && entry) {
          deleteOwnedWebSocketSession(state, sessionId, entry);
        }
        return;
      }
      entry.busy = false;
      scheduleSessionWebSocketExpiry(state, sessionId, entry);
    },
  });
  if (!sessionId) {
    return lease(await connectWebSocket(url, headers, signal));
  }

  const cached = state.sessionCache.get(sessionId);
  // Update the expected lease after our own cleanup before awaiting a new connection.
  let expectedCacheValue: CachedWebSocketConnection | undefined = cached;
  if (cached) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = undefined;
    }
    if (!cached.busy && !matchesCodexWebSocketAuthority(cached.authority, authority)) {
      closeWebSocketSilently(cached.socket, 1000, "authority_changed");
      deleteOwnedWebSocketSession(state, sessionId, cached);
      expectedCacheValue = undefined;
    } else if (!cached.busy && isWebSocketSessionExpired(cached)) {
      closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
      deleteOwnedWebSocketSession(state, sessionId, cached);
      expectedCacheValue = undefined;
    } else if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return lease(cached.socket, cached);
    }
    if (cached.busy) {
      return lease(await connectWebSocket(url, headers, signal));
    }

    if (!isWebSocketReusable(cached.socket)) {
      closeWebSocketSilently(cached.socket);
      deleteOwnedWebSocketSession(state, sessionId, cached);
      expectedCacheValue = undefined;
    }
  }

  const socket = await connectWebSocket(url, headers, signal);
  const entry: CachedWebSocketConnection = {
    socket,
    authority,
    busy: true,
    createdAt: Date.now(),
  };
  // A concurrent winner keeps the cache; this socket then remains transient.
  const ownsCache = setOwnedWebSocketSession(state, sessionId, entry, expectedCacheValue);
  return lease(socket, ownsCache ? entry : undefined);
}

function extractWebSocketError(event: unknown): Error {
  if (event && typeof event === "object") {
    const message = "message" in event ? (event as { message?: unknown }).message : undefined;
    const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
    const eventMessage = typeof message === "string" && message.length > 0 ? message : undefined;
    if (nestedError !== undefined) {
      const cause = toErrorObject(nestedError, eventMessage ?? "WebSocket error");
      return createWebSocketTransportError(
        eventMessage ?? (cause.message || "WebSocket error"),
        cause,
      );
    }
    if (eventMessage) {
      return createWebSocketTransportError(eventMessage);
    }
  }
  return createWebSocketTransportError("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
  if (event && typeof event === "object") {
    const code = "code" in event ? (event as { code?: unknown }).code : undefined;
    const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
    const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
    const codeText = typeof code === "number" ? ` ${code}` : "";
    let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
    if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
      reasonText = " message too big";
    }
    const message = `WebSocket closed${codeText}${reasonText}`;
    const error =
      typeof code === "number" && RETRYABLE_WEBSOCKET_CLOSE_CODES.has(code)
        ? createWebSocketTransportError(message)
        : Object.assign(new Error(message), { code: WEBSOCKET_NON_RETRYABLE_CLOSE_ERROR_CODE });
    return Object.assign(error, {
      name: "WebSocketCloseError",
      closeCode: typeof code === "number" ? code : undefined,
      reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
      wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
    });
  }
  return createWebSocketTransportError("WebSocket closed");
}

async function* parseWebSocket(
  socket: WebSocketLike,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let failed: Error | null = null;
  let sawCompletion = false;

  const wake = () => {
    if (!pending) {
      return;
    }
    const resolve = pending;
    pending = null;
    resolve();
  };
  const finish = (error?: Error) => {
    if (error) {
      failed = error;
    }
    done = true;
    wake();
  };

  const onMessage: WebSocketListener = (event) => {
    const data =
      event && typeof event === "object" && "data" in event
        ? (event as { data?: unknown }).data
        : undefined;
    if (typeof data !== "string") {
      // Codex response events are text frames. Keep malformed transport failures
      // on the shared marker so callers receive the canonical retry guidance.
      finish(
        new CodexProtocolError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, {
          payload: data,
        }),
      );
      return;
    }

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (
        type === "response.completed" ||
        type === "response.done" ||
        type === "response.incomplete"
      ) {
        sawCompletion = true;
        done = true;
      }
      queue.push(parsed);
      wake();
    } catch (cause) {
      finish(
        new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
          cause,
          payload: data,
        }),
      );
    }
  };

  const onError: WebSocketListener = (event) => finish(extractWebSocketError(event));
  const onClose: WebSocketListener = (event) =>
    finish(!sawCompletion && !failed ? extractWebSocketCloseError(event) : undefined);
  const onAbort = () => finish(new Error("Request was aborted"));

  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) {
        throw transportAbortError(signal);
      }
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (done) {
        break;
      }
      await new Promise<void>((resolve) => {
        pending = resolve;
      });
    }

    if (failed) {
      throw toErrorObject(failed, "Non-Error thrown");
    }
    if (!sawCompletion) {
      throw new Error("WebSocket stream closed before response.completed");
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

function serializeRequestContext(body: RequestBody): string {
  const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
  return JSON.stringify(rest);
}

function buildCachedWebSocketRequestBody(
  entry: CachedWebSocketConnection,
  body: RequestBody,
): RequestBody {
  const continuation = entry.continuation;
  if (!continuation) {
    return body;
  }
  const currentInput = body.input ?? [];
  const baseline = [
    ...(continuation.lastRequestBody.input ?? []),
    ...continuation.lastResponseItems,
  ];
  if (
    !continuation.lastResponseId ||
    serializeRequestContext(body) !== serializeRequestContext(continuation.lastRequestBody) ||
    currentInput.length < baseline.length ||
    JSON.stringify(currentInput.slice(0, baseline.length)) !== JSON.stringify(baseline)
  ) {
    entry.continuation = undefined;
    return body;
  }

  return {
    ...body,
    previous_response_id: continuation.lastResponseId,
    input: currentInput.slice(baseline.length),
  };
}

async function processWebSocketStream(
  state: OpenAICodexWebSocketRuntimeState,
  authority: CodexWebSocketAuthority,
  body: RequestBody,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<"openai-chatgpt-responses">,
  onFirstProviderEvent: () => void,
  onStart: () => void,
  options: OpenAICodexResponsesOptions | undefined,
  processStream: ProcessCodexStream,
  observePromptEgress?: ObserveResponsesPromptEgress,
  payloadVariant: ResponsesEncryptedContentAttempt<RequestBody>["kind"] = "initial",
  onRequestSent?: (request: RequestBody) => void,
  activitySignal?: AbortSignal,
): Promise<CompletedResponse | null | undefined> {
  const { socket, entry, release } = await acquireWebSocket(
    state,
    authority,
    options?.sessionId,
    options?.signal,
  );
  let keepConnection = true;
  const useCachedContext =
    options?.transport === "websocket-cached" || options?.transport === "auto";
  // ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
  // WebSocket continuation still works via connection-scoped previous_response_id state.
  const requestBody =
    useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, body) : body;
  async function* acceptedEvents() {
    let started = false;
    for await (const event of mapCodexEvents(
      parseWebSocket(socket, options?.signal),
      undefined,
      options,
    )) {
      if (!started) {
        started = true;
        onFirstProviderEvent();
        onStart();
        await notifyProviderStreamOpened({
          options,
          cancelStream: () => {
            keepConnection = false;
            closeWebSocketSilently(socket);
          },
        });
        stream.push({ type: "start", partial: output });
      }
      yield event;
    }
  }
  try {
    if (options?.signal?.aborted) {
      throw transportAbortError(options.signal);
    }
    observePromptEgress?.(requestBody, {
      egress: "native-codex-websocket",
      payloadVariant,
    });
    const lifecycle = responsesRequestLifecycle.get(options);
    if (lifecycle) {
      await lifecycle.beforeDispatch(options?.signal);
      options?.signal?.throwIfAborted();
      lifecycle.assertCurrent();
    }
    socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
    onRequestSent?.(requestBody);
    const terminal = await processStream(acceptedEvents(), options, activitySignal);
    if (options?.signal?.aborted) {
      keepConnection = false;
    } else if (useCachedContext && entry && output.responseId) {
      const responseItems = convertResponsesMessages(
        model,
        { messages: [output] },
        CODEX_TOOL_CALL_PROVIDERS,
        {
          includeSystemPrompt: false,
          replayResponsesItemIds: false,
          sessionId: options?.sessionId,
          authProfileId: options?.authProfileId,
        },
      ).filter((item) => item.type !== "function_call_output");
      entry.continuation = {
        lastRequestBody: body,
        lastResponseId: output.responseId,
        lastResponseItems: responseItems,
      };
    }
    return terminal;
  } catch (error) {
    if (entry) {
      entry.continuation = undefined;
    }
    keepConnection = false;
    throw error;
  } finally {
    release({ keep: keepConnection });
  }
}

async function readChatGptResponsesErrorTextLimited(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  let text = "";
  let completed = false;
  let cancelPromise: Promise<void> | undefined;
  const cancel = () => {
    cancelPromise ??= reader.cancel(signal?.reason).catch(() => {});
    return cancelPromise;
  };
  const onAbort = () => {
    void cancel();
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const { truncated } = await consumeResponseBytes({
      maxBytes: OPENAI_CHATGPT_RESPONSES_ERROR_BODY_MAX_BYTES,
      stopAtLimit: true,
      read: () => reader.read(),
      onChunk: (chunk) => {
        text += decoder.decode(chunk, { stream: true });
      },
      onLimit: () => {},
    });
    completed = !truncated;
    // A capped prefix may end mid-sequence. Flushing only after EOF avoids
    // inventing a replacement character while preserving malformed full bodies.
    if (completed) {
      text += decoder.decode();
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      // This provider module is browser-safe, so keep error-body cleanup on Web APIs.
      await cancel();
    }
    try {
      reader.releaseLock();
    } catch {}
  }

  return text;
}

function parseErrorResponse(raw: string, response: Response): CodexApiError {
  const { status, statusText } = response;
  let message = raw || statusText || "Request failed";
  let friendlyMessage: string | undefined;
  let code: string | undefined;
  let payload: Record<string, unknown> | undefined;

  try {
    const parsed = JSON.parse(raw) as {
      error?: {
        code?: string;
        type?: string;
        message?: string;
        plan_type?: string;
        resets_at?: number;
      };
    };
    payload = isRecord(parsed) ? parsed : undefined;
    const err = parsed?.error;
    if (err) {
      code = err.code || err.type || undefined;
      if (
        /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code ?? "") ||
        status === 429
      ) {
        const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
        const mins = err.resets_at
          ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
      }
      message = err.message || friendlyMessage || message;
    }
  } catch {}

  const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
  // The canonical projection retains HTTP status; retry owners read its bounded
  // terminal text for pacing, matching Anthropic HTTP error projection.
  const retryAfterSuffix = Number.isFinite(retryAfterSeconds)
    ? `; Retry-After: ${Math.ceil(retryAfterSeconds ?? 0)} seconds`
    : "";
  return new CodexApiError(`${friendlyMessage || message}${retryAfterSuffix}`, {
    code,
    status,
    payload,
  });
}

export function extractOpenAICodexAccountId(token: string): string {
  const accountId = resolveOpenAICodexAccountId(token);
  if (accountId) {
    return accountId;
  }
  throw new Error("Failed to extract accountId from token");
}

function createCodexRequestId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `codex_${suffix}`;
  }
  throw new Error("Secure random request id generation is unavailable");
}

function buildBaseCodexHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
): Headers {
  const headers = new Headers(initHeaders);
  for (const [key, value] of Object.entries(additionalHeaders || {})) {
    headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "openclaw");
  const userAgent = os
    ? `openclaw (${os.platform()} ${os.release()}; ${os.arch()})`
    : "openclaw (browser)";
  headers.set("User-Agent", userAgent);
  return headers;
}

function buildSSEHeaders(
  initHeaders: Record<string, string> | undefined,
  additionalHeaders: Record<string, string> | undefined,
  accountId: string,
  token: string,
  sessionId?: string,
): Headers {
  const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

  if (sessionId) {
    headers.set("session_id", sessionId);
    headers.set("x-client-request-id", sessionId);
  }

  return headers;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
