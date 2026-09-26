import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type { BaseOpenAIStreamOptions } from "../provider-options.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
  type OpenAIResponsesReplayMode,
} from "../transports/openai-responses-compaction-replay.js";
import { recordResponsesContextUsage } from "../transports/openai-responses-context-usage.js";
import type { OpenAIResponsesRequestParams } from "../transports/openai-responses-contracts.js";
import { ResponsesStreamFailure } from "../transports/openai-responses-debug.js";
import {
  createOpenAIResponsesAssistantOutput,
  createResponsesStreamWithEncryptedContentRetry,
} from "../transports/openai-responses-replay-internal.js";
import { hasOnlyResponsesFunctionTools } from "../transports/openai-responses-stream-errors.js";
import { processResponsesStream } from "../transports/openai-responses-stream-internal.js";
import { createOpenAIProviderAcceptanceHook } from "../transports/openai-transport-shared.js";
import {
  failTransportStream,
  finalizeTransportStream,
  withProviderResponseHook,
} from "../transports/transport-stream-shared.js";
import type { Api, AssistantMessage, Context, Model, StreamOptions, Usage } from "../types.js";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.js";
import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  createFirstStreamEventAbortController,
  getFirstStreamEventTimeoutHandler,
  getFirstStreamEventTimeoutMs,
  type FirstStreamEventInternalOptions,
} from "../utils/stream-first-event-timeout.js";
import { readOpenAIMisalignmentReview } from "./openai-provider-refusal.js";
import { supportsOpenAITemperature } from "./openai-reasoning-effort.js";
import {
  resolveOpenAIRequestReasoning,
  type OpenAIRequestReasoningEffort,
} from "./openai-request-reasoning.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";

interface OpenAIResponsesStreamOptions {
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
  resolveServiceTier?: (
    responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
    requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => ResponseCreateParamsStreaming["service_tier"] | undefined;
  applyServiceTierPricing?: (
    usage: Usage,
    serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  ) => void;
}

export { convertResponsesToolPayload };

type ResponsesRequestOptions = {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
};

type ResponsesStreamRequest = {
  withResponse(): Promise<{
    data: AsyncIterable<ResponseStreamEvent>;
    response: Response;
  }>;
};

type ResponsesStreamClient = {
  responses: {
    create(
      params: ResponseCreateParamsStreaming,
      options: ResponsesRequestOptions,
    ): ResponsesStreamRequest;
  };
};

type ResponsesLifecycleStreamOptions = Pick<
  StreamOptions,
  "signal" | "timeoutMs" | "onPayload" | "onResponse" | "sessionId"
> &
  Pick<BaseOpenAIStreamOptions, "authProfileId" | "onCompactionRejected"> &
  FirstStreamEventInternalOptions;

type OpenAIResponsesProcessStreamOptions = OpenAIResponsesStreamOptions &
  FirstStreamEventInternalOptions & { signal?: AbortSignal };

type ResponsesReasoningSummary = "auto" | "detailed" | "concise" | null;

type ResponsesCommonParamsOptions = Pick<StreamOptions, "maxTokens" | "temperature"> & {
  reasoningEffort?: OpenAIRequestReasoningEffort;
  reasoningSummary?: ResponsesReasoningSummary;
};

type ResponsesLifecycleRequest = OpenAIResponsesRequestParams;

export { convertProviderResponsesMessages as convertResponsesMessages } from "../transports/openai-responses-replay-internal.js";

export const createResponsesAssistantOutput = createOpenAIResponsesAssistantOutput;

export function applyResponsesServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
  model: Pick<Model, "id">,
): void {
  let multiplier = 1;
  if (serviceTier === "flex") {
    multiplier = 0.5;
  } else if (serviceTier === "priority") {
    multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
  }
  if (multiplier === 1) {
    return;
  }

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export function applyCommonResponsesParams<TApi extends Api>(
  params: ResponseCreateParamsStreaming,
  model: Model<TApi>,
  context: Context,
  options?: ResponsesCommonParamsOptions,
  config?: { setDefaultReasoningOff?: boolean },
): void {
  if (options?.maxTokens) {
    params.max_output_tokens = Math.max(options.maxTokens, 16);
  }

  if (options?.temperature !== undefined && supportsOpenAITemperature(model)) {
    params.temperature = options.temperature;
  }

  if (context.tools) {
    const tools = convertResponsesToolPayload(context.tools, { model });
    if (tools.length > 0) {
      params.tools = tools;
    }
  }

  if (!model.reasoning) {
    return;
  }

  const requestedEffort =
    options?.reasoningEffort ??
    (options?.reasoningSummary
      ? "medium"
      : (config?.setDefaultReasoningOff ?? true)
        ? "off"
        : undefined);
  const effort =
    requestedEffort === undefined
      ? undefined
      : resolveOpenAIRequestReasoning(model, requestedEffort).effort;
  if (effort === undefined) {
    return;
  }
  params.reasoning = { effort: effort as NonNullable<typeof params.reasoning>["effort"] };
  if (effort !== "none" && (options?.reasoningEffort || options?.reasoningSummary)) {
    params.reasoning.summary = options?.reasoningSummary || "auto";
    params.include = ["reasoning.encrypted_content"];
  }
}

function buildResponsesRequestOptions(
  options: ResponsesLifecycleStreamOptions | undefined,
): ResponsesRequestOptions {
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    maxRetries: 0,
  };
}

function cleanStreamingScratchBuffers(output: AssistantMessage): void {
  for (const block of output.content) {
    delete (block as { index?: number }).index;
    // partialJson is only a streaming scratch buffer; never persist it.
    delete (block as { partialJson?: string }).partialJson;
  }
}

export async function runResponsesStreamLifecycle<TApi extends Api>(params: {
  stream: AssistantMessageEventStream;
  model: Model<TApi>;
  output: AssistantMessage;
  options?: ResponsesLifecycleStreamOptions;
  resolveRequestModel?: (model: Model<TApi>) => Model<TApi>;
  createClient: (model: Model<TApi>) => ResponsesStreamClient;
  buildParams: (
    model: Model<TApi>,
    replayMode: OpenAIResponsesReplayMode,
  ) => ResponsesLifecycleRequest;
  processStreamOptions?: OpenAIResponsesProcessStreamOptions;
}): Promise<void> {
  const { stream, output, options } = params;

  let firstEventAbort: ReturnType<typeof createFirstStreamEventAbortController> | undefined;
  try {
    const model = params.resolveRequestModel?.(params.model) ?? params.model;
    const client = params.createClient(model);
    const buildRequest = async (replayMode: OpenAIResponsesReplayMode) => {
      let request = params.buildParams(model, replayMode);
      const nextRequest = await options?.onPayload?.(request, model);
      if (nextRequest !== undefined) {
        request = nextRequest as ResponsesLifecycleRequest;
      }
      return request;
    };
    const requestParams = await buildRequest("checkpoint");

    const firstEvent = createFirstStreamEventAbortController(options?.signal);
    firstEventAbort = firstEvent;
    let started = false;
    let admittedRequest: ResponsesLifecycleRequest | undefined;
    const { stream: hookedOpenAIStream } = await createResponsesStreamWithEncryptedContentRetry({
      client: client as never,
      request: requestParams as never,
      requestOptions: {
        ...buildResponsesRequestOptions(options),
        signal: firstEvent.signal,
      },
      model,
      buildFullHistoryRequest: () => buildRequest("full-history"),
      onCompactionRejected: (checkpoint) =>
        suppressOpenAIResponsesCompaction(output, model, options, checkpoint),
      canRetryStream: () => output.content.length === 0,
      wrapStream: ({ stream: openaiStream, response, attempt }) => {
        admittedRequest = attempt.kind === "initial" ? attempt.request : undefined;
        return withProviderResponseHook({
          stream: openaiStream,
          signal: firstEvent.signal,
          abort: firstEvent.abort,
          hook: createOpenAIProviderAcceptanceHook(options, response, model),
          onReady: () => {
            if (!started) {
              started = true;
              stream.push({ type: "start", partial: output });
            }
          },
        });
      },
    });

    const firstEventTimeoutMs = getFirstStreamEventTimeoutMs(options);
    const onFirstEventTimeout = getFirstStreamEventTimeoutHandler(options);
    const processStreamOptions =
      params.processStreamOptions ||
      firstEventTimeoutMs !== undefined ||
      onFirstEventTimeout !== undefined
        ? {
            ...params.processStreamOptions,
            firstEventTimeoutMs:
              params.processStreamOptions?.firstEventTimeoutMs ?? firstEventTimeoutMs,
            abortFirstEventStream:
              params.processStreamOptions?.abortFirstEventStream ?? firstEventAbort.abort,
            onFirstEventTimeout:
              params.processStreamOptions?.onFirstEventTimeout ?? onFirstEventTimeout,
            signal: params.processStreamOptions?.signal ?? options?.signal,
          }
        : undefined;
    const terminal = await processResponsesStream(hookedOpenAIStream, output, stream, model, {
      ...processStreamOptions,
      canRetryIdentityConflict: () => hasOnlyResponsesFunctionTools(admittedRequest),
      reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
        sessionId: options?.sessionId,
        authProfileId: options?.authProfileId,
      }),
    });

    if (terminal && admittedRequest && !options?.signal?.aborted) {
      recordResponsesContextUsage(
        output,
        model,
        options,
        admittedRequest,
        terminal.output,
        "provider",
      );
    }
    finalizeTransportStream({ stream, output, signal: options?.signal });
  } catch (error) {
    const response = error instanceof ResponsesStreamFailure ? error.response : error;
    const rawError = isRecord(response) && isRecord(response.error) ? response.error : response;
    if (
      params.model.provider === "openai" &&
      params.model.api === "openai-responses" &&
      isRecord(rawError) &&
      rawError.code === "misalignment_policy_violation"
    ) {
      // The ordinary API has no reviewed-continuation contract. Preserve findings only.
      const review = readOpenAIMisalignmentReview(rawError.misalignment, false);
      appendAssistantMessageDiagnostic(output, {
        type: "provider_refusal",
        timestamp: Date.now(),
        details: { provider: "openai", category: "misalignment", ...(review ? { review } : {}) },
      });
    }
    failTransportStream({
      stream,
      output,
      signal: options?.signal,
      error,
      cleanup: () => cleanStreamingScratchBuffers(output),
    });
  } finally {
    firstEventAbort?.dispose();
  }
}
