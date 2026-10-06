import { randomUUID } from "node:crypto";
import type { AssistantMessageEvent, Context, Model, StreamFn } from "@openclaw/llm-core";
import OpenAI from "openai";
import { getEnvApiKey } from "../env-api-keys.js";
import {
  codeModeToolSurfaceObserver,
  reasoningTagTextPolicy,
  type OpenAICompletionsOptions,
} from "../provider-options.js";
import { resolveCacheRetention } from "../providers/cache-retention.js";
import { buildCopilotDynamicHeaders } from "../providers/github-copilot-headers.js";
import { finalizeOpenAICompletionsToolCalls } from "../providers/openai-completions-tool-calls.js";
import { createOpenAIProviderClient } from "../providers/openai-provider-client.js";
import {
  clearPendingCommentaryText,
  tagUnresolvedTextAsCommentary,
  type PendingCommentaryTags,
} from "../utils/assistant-text-phase.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
} from "../utils/stream-first-event-timeout.js";
import { createAssistantOutput } from "./assistant-output.js";
import { buildGuardedModelFetch } from "./host-policy.js";
import { prepareModelRequestBody } from "./model-request-body.js";
import { hasOpenAICompatibleConversationTurn } from "./openai-compatible-conversation-turn.js";
import { resolveOpenAICompletionsCompat } from "./openai-completions-compat.js";
import { isAzureOpenAICompatibleHost } from "./openai-completions-host.js";
import { buildOpenAICompletionsRequest } from "./openai-completions-params.js";
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
  isOpenAICompletionsThinkingEnabled,
  resolveOpenAIClientBaseUrl,
  resolvePromptCacheKey,
  type MutableAssistantOutput,
} from "./openai-transport-shared.js";
import {
  filterProviderTurnHeadersForExplicitOpencodeSession,
  resolveProviderSimpleCompletionHeaders,
  resolveProviderTransportTurnState,
} from "./provider-transport-turn-state.js";
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";
import {
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  transportAbortError,
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

function buildOpenAICompletionsClientConfig(
  model: Model,
  headers: Record<string, string>,
): {
  baseURL: string | undefined;
  defaultHeaders: Record<string, string>;
  defaultQuery?: Record<string, string>;
} {
  const defaultQuery: Record<string, string> = {};
  let baseURL = model.baseUrl;
  let isAzureHost = false;

  // Keep invalid configured URLs unchanged so the OpenAI SDK owns their errors.
  const parsed = URL.parse(model.baseUrl);
  if (parsed) {
    isAzureHost = isAzureOpenAICompatibleHost(parsed.hostname.toLowerCase());
    parsed.searchParams.forEach((value, key) => {
      if (value) {
        defaultQuery[key] = value;
      }
    });
    parsed.search = "";
    baseURL = parsed.toString().replace(/\/$/, "");
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

function createDirectCompletionsEventStream(
  output: MutableAssistantOutput,
  stream: { push(event: AssistantMessageEvent): void },
) {
  type StreamingBlock = MutableAssistantOutput["content"][number];
  const finishedBlocks = new Set<StreamingBlock>();
  const contentIndices = new WeakMap<StreamingBlock, number>();
  let openTextBlock: StreamingBlock | undefined;
  let openThinkingBlock: StreamingBlock | undefined;
  const finishBlock = (block: StreamingBlock) => {
    const contentIndex = contentIndices.get(block);
    if (contentIndex === undefined || finishedBlocks.has(block)) {
      return;
    }
    finishedBlocks.add(block);
    if (block.type === "text") {
      openTextBlock = undefined;
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
    } else if (block.type === "thinking") {
      openThinkingBlock = undefined;
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: output,
      });
    } else if (block.type === "toolCall") {
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
    }
  };
  const eventStream = {
    push(event: Parameters<typeof stream.push>[0]) {
      if (
        event.type === "text_start" ||
        event.type === "thinking_start" ||
        event.type === "toolcall_start"
      ) {
        const block = output.content[event.contentIndex];
        if (block) {
          contentIndices.set(block, event.contentIndex);
          if (block.type === "text") {
            openTextBlock = block;
          } else if (block.type === "thinking") {
            openThinkingBlock = block;
          }
        }
      }
      stream.push(event);
    },
  };
  return {
    stream: eventStream,
    beforeContentBlock: (nextType: "text" | "thinking" | "toolCall") => {
      if (openThinkingBlock) {
        finishBlock(openThinkingBlock);
      }
      if (openTextBlock && nextType !== "toolCall") {
        finishBlock(openTextBlock);
      }
    },
    finish(includeToolCalls: boolean) {
      for (const block of output.content) {
        if (block.type !== "toolCall" || includeToolCalls) {
          finishBlock(block);
        }
      }
    },
  };
}

export function createOpenAICompletionsTransportStreamFn(): StreamFn {
  return (model, context, options) =>
    streamOpenAICompletionsRequest(
      model as Model<"openai-completions">,
      context,
      options as OpenAICompletionsOptions | undefined,
      "managed",
    );
}

export function streamOpenAICompletionsRequest(
  model: Model<"openai-completions">,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
  mode: "direct" | "managed",
) {
  const { eventStream, stream } = createWritableTransportEventStream();
  void (async () => {
    const output: MutableAssistantOutput = createAssistantOutput(model);
    const provisionalCommentaryTags: PendingCommentaryTags = new Map();
    let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
    try {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const directEmitReasoning = Boolean(
        mode === "direct" &&
        model.reasoning &&
        options?.reasoningEffort &&
        isOpenAICompletionsThinkingEnabled(options.reasoningEffort),
      );
      const cacheRetention = resolveCacheRetention(options?.cacheRetention);
      const policy =
        mode === "direct"
          ? { mode, compat: resolveOpenAICompletionsCompat(model), cacheRetention }
          : { mode };
      const { client, sawStreamDONE } =
        policy.mode === "direct"
          ? {
              client: createDirectCompletionsClient(
                model,
                context,
                apiKey,
                resolveProviderSimpleCompletionHeaders(model, options),
                cacheRetention === "none" ? undefined : options?.sessionId,
                policy.compat,
              ),
              sawStreamDONE: undefined,
            }
          : createManagedCompletionsClient(model, context, options, apiKey, cacheRetention);
      let params = buildOpenAICompletionsRequest(model, context, options, policy);
      const encodeBody = prepareModelRequestBody(options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as typeof params;
      }
      if (mode === "managed") {
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
        if (getCompat(model).requiresNonEmptyUserOrAssistantMessage) {
          assertOpenAICompletionsPayloadHasConversationTurn(params, model);
        }
      }
      const emitReasoning =
        mode === "direct"
          ? directEmitReasoning
          : shouldEmitOpenAICompletionsReasoning(model, options);
      firstEventAbort = createFirstStreamEventAbortController(options?.signal);
      const requestOptions =
        mode === "direct"
          ? {
              ...(await encodeBody(params)),
              signal: firstEventAbort.signal,
              ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
              maxRetries: 0,
            }
          : {
              ...buildOpenAISdkRequestOptions(model, firstEventAbort.signal, {
                timeoutMs: options?.timeoutMs,
              }),
              ...(await encodeBody(params)),
            };
      const { data: responseStream, response } = await client.chat.completions
        .create(
          params as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          requestOptions,
        )
        .withResponse();
      const hookedResponseStream = withProviderResponseHook({
        stream: responseStream,
        signal: firstEventAbort.signal,
        abort: firstEventAbort.abort,
        hook: createOpenAIProviderAcceptanceHook(options, response, model),
        onReady: () => stream.push({ type: "start", partial: output }),
      });
      const directEvents =
        mode === "direct" ? createDirectCompletionsEventStream(output, stream) : undefined;
      try {
        await processCompletionsStream(
          hookedResponseStream,
          output,
          model,
          directEvents?.stream ?? stream,
          {
            ...(directEvents
              ? {
                  mode: "direct" as const,
                  beforeContentBlock: directEvents.beforeContentBlock,
                  provisionalCommentaryTags,
                }
              : { mode: "managed" as const }),
            signal: options?.signal,
            emitReasoning,
            strictReasoningTags: reasoningTagTextPolicy.isStrict(options),
            firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
            abortFirstEventStream: firstEventAbort.abort,
            onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
            sawStreamDONE,
          },
        );
        if (directEvents) {
          if (options?.signal?.aborted) {
            throw transportAbortError(options.signal);
          }
          if (output.stopReason === "aborted" || output.stopReason === "error") {
            throw new Error(
              output.errorMessage ||
                (output.stopReason === "aborted"
                  ? "Request was aborted"
                  : "Provider returned an invalid tool call"),
            );
          }
        }
      } catch (error) {
        directEvents?.finish(false);
        throw error;
      }
      directEvents?.finish(output.stopReason === "toolUse");
      finalizeTransportStream({ stream, output, signal: options?.signal });
    } catch (error) {
      failTransportStream({
        stream,
        output,
        signal: options?.signal,
        error,
        cleanup: () => {
          finalizeOpenAICompletionsToolCalls(output, { allowSilentToolCallPromotion: false });
          clearPendingCommentaryText(provisionalCommentaryTags);
          tagUnresolvedTextAsCommentary(output);
          if (mode === "direct") {
            for (const block of output.content) {
              delete (block as { index?: number }).index;
              delete (block as { partialArgs?: string }).partialArgs;
              delete (block as { streamIndex?: number }).streamIndex;
            }
          }
        },
      });
    } finally {
      firstEventAbort?.dispose();
    }
  })();
  return eventStream;
}

function createDirectCompletionsClient(
  model: Model<"openai-completions">,
  context: Context,
  apiKey: string,
  optionsHeaders: Record<string, string> | undefined,
  sessionId: string | undefined,
  compat: ReturnType<typeof resolveOpenAICompletionsCompat>,
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    Object.assign(headers, buildCopilotDynamicHeaders(context.messages));
  }
  if (sessionId && compat.sessionAffinity !== "none") {
    if (compat.sessionAffinity === "openrouter") {
      headers["x-session-id"] = sessionId;
    } else {
      headers.session_id = sessionId;
      headers["x-client-request-id"] = sessionId;
      headers["x-session-affinity"] = sessionId;
    }
  }
  return createOpenAIProviderClient(model, apiKey, headers, optionsHeaders);
}

function createManagedCompletionsClient(
  model: Model,
  context: Context,
  options: OpenAICompletionsOptions | undefined,
  apiKey: string,
  cacheRetention: ReturnType<typeof resolveCacheRetention>,
) {
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
  // The SDK consumes DONE without yielding it; native tool calls need to distinguish it from EOF.
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
  const clientConfig = buildOpenAICompletionsClientConfig(
    model,
    buildOpenAIClientHeaders(
      model,
      context,
      { ...turnHeaders, ...optionHeaders },
      undefined,
      resolvePromptCacheKey(options, cacheRetention),
      cacheRetention,
    ),
  );
  return {
    client: new OpenAI({
      apiKey,
      baseURL: clientConfig.baseURL,
      dangerouslyAllowBrowser: true,
      defaultHeaders: clientConfig.defaultHeaders,
      defaultQuery: clientConfig.defaultQuery,
      fetch: doneDetectingFetch,
      ...buildOpenAISdkClientOptions(model),
    }),
    sawStreamDONE: doneDetector.sawDone,
  };
}
