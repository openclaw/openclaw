import { randomUUID } from "node:crypto";
import type { AssistantMessageEvent, Context, Model, StreamFn } from "@openclaw/llm-core";
import OpenAI from "openai";
import { getEnvApiKey } from "../env-api-keys.js";
import {
  codeModeToolSurfaceObserver,
  reasoningTagTextPolicy,
  type OpenAICompletionsOptions,
} from "../provider-options.js";
import { finalizeOpenAICompletionsToolCalls } from "../providers/openai-completions-tool-calls.js";
import { tagUnresolvedTextAsCommentary } from "../utils/assistant-text-phase.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  withFirstStreamEventTimeout,
} from "../utils/stream-first-event-timeout.js";
import { buildGuardedModelFetch } from "./host-policy.js";
import { hasOpenAICompatibleConversationTurn } from "./openai-compatible-conversation-turn.js";
import { bufferContextLimitedCompletions } from "./openai-completions-context-budget-buffer.js";
import { isAzureOpenAICompatibleHost } from "./openai-completions-host.js";
import {
  buildOpenAICompletionsParams,
  resolveOpenAICompletionsContextBudgetLimit,
} from "./openai-completions-params.js";
import {
  processCompletionsStream,
  shouldEmitOpenAICompletionsReasoning,
} from "./openai-completions-stream.js";
import {
  assertCodeModeResponsesToolSurface,
  buildOpenAIClientHeaders,
  buildOpenAISdkClientOptions,
  buildOpenAISdkRequestOptions,
  enforceCodeModeResponsesToolSurface,
  getCompat,
  resolveCodeModeResponsesVisibleToolNames,
} from "./openai-transport-params.js";
import {
  createOpenAIProviderAcceptanceHook,
  resolveOpenAIClientBaseUrl,
  type MutableAssistantOutput,
  type OpenAIModeModel,
} from "./openai-transport-shared.js";
import {
  filterProviderTurnHeadersForExplicitOpencodeSession,
  resolveProviderTransportTurnState,
} from "./provider-transport-turn-state.js";
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";
import {
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  withProviderResponseHook,
} from "./transport-stream-shared.js";

export { buildOpenAICompletionsParams } from "./openai-completions-params.js";

function assertOpenAICompletionsPayloadHasConversationTurn(
  params: Record<string, unknown>,
  model: Model,
): void {
  const messages = params.messages;
  if (!Array.isArray(messages) || hasOpenAICompatibleConversationTurn(messages)) {
    return;
  }
  throw new Error(
    `OpenAI-compatible chat payload for ${model.provider}/${model.id} contains no non-empty user or assistant messages after compaction and transport transforms; refusing to send a system/tool-only request. Start a new user turn or repair the compacted session history.`,
  );
}

const SSE_DONE_LINE_RE = /^data:[ \t]*\[DONE\][ \t]*$/i;
const SSE_DONE_MAX_LINE_CHARS = 1_024;
const CONTEXT_LIMITED_RESPONSE_MAX_BUFFERED_EVENTS = 256;
const CONTEXT_LIMITED_RESPONSE_MAX_BUFFERED_CHARS = 262_144;

function createSseDoneDetector() {
  const decoder = new TextDecoder();
  let line = "";
  let lineOverflowed = false;
  let sawDone = false;

  const finishLine = () => {
    if (!lineOverflowed && SSE_DONE_LINE_RE.test(line)) {
      sawDone = true;
    }
    line = "";
    lineOverflowed = false;
  };
  const observeText = (text: string) => {
    for (const char of text) {
      if (char === "\n" || char === "\r") {
        finishLine();
        continue;
      }
      if (!lineOverflowed && line.length < SSE_DONE_MAX_LINE_CHARS) {
        line += char;
      } else {
        // Never let truncation turn a suffix of a large data line into a
        // standalone terminal marker.
        lineOverflowed = true;
      }
    }
  };

  return {
    observe(chunk: Uint8Array) {
      if (!sawDone) {
        observeText(decoder.decode(chunk, { stream: true }));
      }
    },
    finish() {
      if (sawDone) {
        return;
      }
      observeText(decoder.decode());
      if (line || lineOverflowed) {
        finishLine();
      }
    },
    sawDone: () => sawDone,
  };
}

function createOpenAICompletionsClient(
  model: Model,
  context: Context,
  apiKey: string,
  optionHeaders?: Record<string, string>,
  opts?: { fetch?: typeof globalThis.fetch },
) {
  const clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders);
  return new OpenAI({
    apiKey,
    baseURL: clientConfig.baseURL,
    dangerouslyAllowBrowser: true,
    defaultHeaders: clientConfig.defaultHeaders,
    defaultQuery: clientConfig.defaultQuery,
    fetch: opts?.fetch ?? buildGuardedModelFetch(model),
    ...buildOpenAISdkClientOptions(model),
  });
}

function buildOpenAICompletionsClientConfig(
  model: Model,
  context: Context,
  optionHeaders?: Record<string, string>,
): {
  baseURL: string | undefined;
  defaultHeaders: Record<string, string>;
  defaultQuery?: Record<string, string>;
} {
  const headers = buildOpenAIClientHeaders(model, context, optionHeaders);
  const defaultQuery: Record<string, string> = {};
  let baseURL = model.baseUrl;
  let isAzureHost = false;

  try {
    const parsed = new URL(model.baseUrl);
    isAzureHost = isAzureOpenAICompatibleHost(parsed.hostname.toLowerCase());
    parsed.searchParams.forEach((value, key) => {
      if (value) {
        defaultQuery[key] = value;
      }
    });
    parsed.search = "";
    baseURL = parsed.toString().replace(/\/$/, "");
  } catch {
    // Keep the configured base URL unchanged; the OpenAI SDK will surface invalid URLs.
  }

  if (isAzureHost) {
    const apiVersionHeader = Object.keys(headers).find(
      (key) => key.toLowerCase() === "api-version",
    );
    if (apiVersionHeader) {
      const apiVersion = headers[apiVersionHeader]?.trim();
      delete headers[apiVersionHeader];
      if (apiVersion && !defaultQuery["api-version"]) {
        defaultQuery["api-version"] = apiVersion;
      }
    }
  }

  return {
    baseURL: resolveOpenAIClientBaseUrl(model, baseURL),
    defaultHeaders: headers,
    defaultQuery: Object.keys(defaultQuery).length > 0 ? defaultQuery : undefined,
  };
}

export function createOpenAICompletionsTransportStreamFn(): StreamFn {
  return (model, context, options) => {
    const { eventStream, stream } = createWritableTransportEventStream();
    void (async () => {
      const output: MutableAssistantOutput = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
      let bufferedEvents: AssistantMessageEvent[] | undefined;
      let discardCandidateEvents = false;
      try {
        const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
        const turnState = resolveProviderTransportTurnState(model, {
          sessionId: options?.sessionId,
          turnId: randomUUID(),
          attempt: 1,
          transport: "stream",
        });
        const optionHeaders = resolveOpencodeSessionHeaders(model, options);
        const turnHeaders = filterProviderTurnHeadersForExplicitOpencodeSession(
          model,
          options,
          turnState?.headers,
        );
        // The OpenAI SDK consumes the SSE terminal without yielding it. Observe
        // the raw body so native tool calls can distinguish clean DONE from EOF.
        const doneDetector = createSseDoneDetector();
        const baseFetch = buildGuardedModelFetch(model);
        const doneDetectingFetch: typeof globalThis.fetch = async (url, init) => {
          const response = await baseFetch(url as never, init);
          if (!response.body || !response.ok) {
            return response;
          }
          if (typeof TransformStream === "undefined" || !response.body.pipeThrough) {
            return response;
          }
          const transformed = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                doneDetector.observe(chunk);
                controller.enqueue(chunk);
              },
              flush() {
                doneDetector.finish();
              },
            }),
          );
          return new Response(transformed, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
          });
        };
        const client = createOpenAICompletionsClient(
          model,
          context,
          apiKey,
          { ...turnHeaders, ...optionHeaders },
          {
            fetch: doneDetectingFetch,
          },
        );
        let params = buildOpenAICompletionsParams(
          model as OpenAIModeModel,
          context,
          options as OpenAICompletionsOptions | undefined,
        );
        // A hook may introduce its own cap. Recovery requires that
        // context budgeting already imposed it before the hook ran.
        const originalContextBudgetLimit = resolveOpenAICompletionsContextBudgetLimit(
          model,
          params,
          options,
        );
        const nextParams = await options?.onPayload?.(params, model);
        if (nextParams !== undefined) {
          params = nextParams as typeof params;
        }
        if (
          (options as { openclawCodeModeToolSurface?: unknown } | undefined)
            ?.openclawCodeModeToolSurface === true
        ) {
          const visibleToolNames = resolveCodeModeResponsesVisibleToolNames(context);
          enforceCodeModeResponsesToolSurface(
            params,
            visibleToolNames,
            undefined,
            codeModeToolSurfaceObserver.get(options),
          );
          assertCodeModeResponsesToolSurface(params, visibleToolNames);
        }
        const compat = getCompat(model as OpenAIModeModel);
        if (compat.requiresNonEmptyUserOrAssistantMessage) {
          assertOpenAICompletionsPayloadHasConversationTurn(params, model);
        }
        const contextBudgetLimited =
          originalContextBudgetLimit !== undefined &&
          resolveOpenAICompletionsContextBudgetLimit(model, params, options) ===
            originalContextBudgetLimit;
        let bufferedChars = 0;
        const pendingEvents: AssistantMessageEvent[] | undefined = contextBudgetLimited
          ? []
          : undefined;
        bufferedEvents = pendingEvents;
        // A length response must not publish partial text or admit async tools
        // before recovery. Snapshot even start: partial points at mutable output.
        const responseEvents = pendingEvents
          ? {
              push(event: AssistantMessageEvent) {
                if (discardCandidateEvents) {
                  return;
                }
                options?.signal?.throwIfAborted();
                if (!bufferedEvents) {
                  stream.push(event);
                  return;
                }
                const eventChars = JSON.stringify(event).length;
                if (
                  pendingEvents.length >= CONTEXT_LIMITED_RESPONSE_MAX_BUFFERED_EVENTS ||
                  bufferedChars + eventChars > CONTEXT_LIMITED_RESPONSE_MAX_BUFFERED_CHARS
                ) {
                  // Successful and over-bound provider output remains streamable.
                  // Known length responses use the sink before reaching this bound.
                  bufferedEvents = undefined;
                  for (const pendingEvent of pendingEvents) {
                    stream.push(pendingEvent);
                  }
                  pendingEvents.length = 0;
                  bufferedChars = 0;
                  stream.push(event);
                  return;
                }
                bufferedChars += eventChars;
                pendingEvents.push(structuredClone(event));
              },
            }
          : stream;
        const emitReasoning = shouldEmitOpenAICompletionsReasoning(
          model as OpenAIModeModel,
          options as OpenAICompletionsOptions | undefined,
        );
        firstEventAbort = createFirstStreamEventAbortController(options?.signal);
        const { data: responseStream, response } = await client.chat.completions
          .create(
            params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
            buildOpenAISdkRequestOptions(model, firstEventAbort.signal, {
              timeoutMs: options?.timeoutMs,
            }),
          )
          .withResponse();
        const hookedResponseStream = withProviderResponseHook({
          stream: responseStream,
          signal: firstEventAbort.signal,
          abort: firstEventAbort.abort,
          hook: createOpenAIProviderAcceptanceHook(options, response, model),
          onReady: () => responseEvents.push({ type: "start", partial: output }),
        });
        let reducerStream = hookedResponseStream;
        let budgetRecoveryAllowed = contextBudgetLimited;
        if (contextBudgetLimited) {
          const buffered = await bufferContextLimitedCompletions(
            withFirstStreamEventTimeout(hookedResponseStream, {
              provider: model.provider,
              api: model.api,
              model: model.id,
              timeoutMs: getFirstStreamEventTimeoutMs(options) ?? 0,
              stage: "completions",
              abort: firstEventAbort.abort,
              onTimeout: getFirstStreamEventTimeoutHandler(options),
            }),
            {
              signal: options?.signal,
              onChunk: () => notifyLlmRequestActivity(options?.signal),
            },
          );
          reducerStream = buffered.stream;
          budgetRecoveryAllowed = buffered.bounded;
          discardCandidateEvents =
            buffered.bounded &&
            (buffered.failed ||
              buffered.finishReason === "length" ||
              options?.signal?.aborted === true);
          if (discardCandidateEvents && pendingEvents) {
            pendingEvents.length = 0;
          }
        }
        await processCompletionsStream(reducerStream, output, model, responseEvents, {
          // The bounded rejected prefix is local data. Reduce it even after
          // cancellation to retain usage; its events cannot admit async tools.
          signal: discardCandidateEvents ? undefined : options?.signal,
          emitReasoning,
          strictReasoningTags: reasoningTagTextPolicy.isStrict(options),
          firstEventTimeoutMs: contextBudgetLimited ? 0 : getFirstStreamEventTimeoutMs(options),
          abortFirstEventStream: firstEventAbort.abort,
          onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
          sawStreamDONE: doneDetector.sawDone,
        });
        if (
          bufferedEvents &&
          !options?.signal?.aborted &&
          output.stopReason !== "error" &&
          output.stopReason !== "aborted"
        ) {
          if (budgetRecoveryAllowed && output.stopReason === "length") {
            throw new Error(
              `Context length exceeded: the provider reached the ${originalContextBudgetLimit}-token output limit imposed by the context budget. Compact the context and retry.`,
            );
          }
          for (const event of bufferedEvents) {
            stream.push(event);
          }
          bufferedEvents = undefined;
        }
        finalizeTransportStream({ stream, output, signal: options?.signal });
      } catch (error) {
        if (bufferedEvents || discardCandidateEvents) {
          // Keep real usage and the failure classification, never this attempt's
          // unpublished candidate content. Completed transcript tools are elsewhere.
          output.content = [];
        }
        failTransportStream({
          stream,
          output,
          signal: options?.signal,
          error,
          cleanup: () => {
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            finalizeOpenAICompletionsToolCalls(output, { allowSilentToolCallPromotion: false });
            tagUnresolvedTextAsCommentary(output);
          },
        });
      } finally {
        firstEventAbort?.dispose();
      }
    })();
    return eventStream;
  };
}
