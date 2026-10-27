import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { APIError } from "openai";
import { Stream } from "openai/core/streaming";
import type { ResponseInput } from "openai/resources/responses/responses.js";
import type { CompactionReplayRejection } from "../provider-options.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import { prepareModelRequestBody } from "./model-request-body.js";
import type { createOpenAIResponsesClient } from "./openai-responses-client.js";
import {
  DEFAULT_AZURE_OPENAI_API_VERSION,
  isPreviousResponseRejection,
  type OpenAIResponsesRequestParams,
  type ResponsesPromptObservation,
} from "./openai-responses-contracts.js";
import { supportsNativeOpenAIResponsesEndpoint } from "./openai-responses-endpoint.js";
import type { createResponsesPromptEgressObserver } from "./openai-responses-prompt-observer-internal.js";
import { stripEncryptedReasoningContentFields } from "./openai-responses-replay-messages-internal.js";
import {
  isResponsesServiceTierRejection,
  nextResponsesServiceTier,
} from "./openai-responses-service-tier.js";
import { log } from "./openai-transport-shared.js";
import { iterateSseFrames } from "./transport-stream-shared.js";

type ResponsesClientLike = ReturnType<typeof createOpenAIResponsesClient>;
const PRELUDE_TYPES = new Set(["response.created", "response.in_progress", "response.queued"]);

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    Symbol.asyncIterator in value
  );
}

export function readResponsesRecoveryEvent(event: unknown) {
  const record = isRecord(event) ? event : undefined;
  const response = isRecord(record?.response) ? record.response : undefined;
  return {
    failure:
      record?.type === "response.failed"
        ? response?.error
        : record?.type === "error"
          ? (record.error ?? record)
          : undefined,
    hasResponseOutput: Array.isArray(response?.output) && response.output.length > 0,
    isPrelude: record !== undefined && PRELUDE_TYPES.has(String(record.type)),
  };
}

export function isInvalidEncryptedContentError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown; status?: unknown };
  if (record.code === "invalid_encrypted_content" || record.code === "thinking_signature_invalid") {
    return true;
  }
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  return (
    message.includes("invalid_encrypted_content") ||
    message.includes("thinking_signature_invalid") ||
    ((record.status === 400 ||
      (record.status == null && /(?:^|[\s(])400(?:[\s):]|$)/.test(message))) &&
      (message.includes("could not decrypt the provided encrypted_content") ||
        (message.includes("encrypted content") &&
          (message.includes("could not be verified") ||
            message.includes("could not be decrypted or parsed")))))
  );
}

function isOrphanedFunctionCallOutputError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : "";
  // Server rejects a function_call_output whose function_call lives inside the
  // encrypted compaction blob. Match by substring like the sibling classifiers:
  // wrapped transport errors prefix the raw body ("400 ...", "HTTP 400: {json}").
  return /No tool call found for function call output with call_id [A-Za-z0-9_-]+/.test(message);
}

type ResponsesEncryptedContentRequest = { input?: ResponseInput };

type ResponsesEncryptedContentAttemptKind = ResponsesPromptObservation["payloadVariant"];

export type ResponsesEncryptedContentAttempt<TRequest extends ResponsesEncryptedContentRequest> = {
  kind: ResponsesEncryptedContentAttemptKind;
  request: TRequest;
  rejectedCompaction?: CompactionReplayRejection;
};

export function commitResponsesEncryptedContentAttempt(
  attempt: ResponsesEncryptedContentAttempt<ResponsesEncryptedContentRequest>,
  commit: (checkpoint: CompactionReplayRejection | undefined) => void,
): void {
  if (attempt.kind === "compaction-stripped") {
    commit(attempt.rejectedCompaction);
  }
}

function stripResponsesRequestEncryptedReasoning<TRequest extends ResponsesEncryptedContentRequest>(
  request: TRequest,
): TRequest {
  const stripped = stripEncryptedReasoningContentFields(request.input);
  return stripped === request.input ? request : { ...request, input: stripped as ResponseInput };
}

function stripResponsesRequestCompaction<TRequest extends ResponsesEncryptedContentRequest>(
  request: TRequest,
): TRequest {
  if (!Array.isArray(request.input)) {
    return request;
  }
  const input = request.input.filter(
    (item) =>
      !(
        item !== null &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "compaction"
      ),
  );
  return input.length === request.input.length ? request : { ...request, input };
}

function readOpenAIResponsesCompactionRejection(
  request: ResponsesEncryptedContentRequest,
): CompactionReplayRejection | undefined {
  if (!Array.isArray(request.input)) {
    return undefined;
  }
  const item = request.input.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as { type?: unknown }).type === "compaction" &&
      typeof (candidate as { encrypted_content?: unknown }).encrypted_content === "string",
  ) as { encrypted_content: string; id?: unknown } | undefined;
  return item
    ? { data: item.encrypted_content, ...(typeof item.id === "string" ? { id: item.id } : {}) }
    : undefined;
}

export async function resolveNextResponsesEncryptedContentAttempt<
  TRequest extends ResponsesEncryptedContentRequest,
>(
  attempt: ResponsesEncryptedContentAttempt<TRequest>,
  error: unknown,
  options: { buildFullHistoryRequest: () => TRequest | Promise<TRequest> },
): Promise<ResponsesEncryptedContentAttempt<TRequest> | undefined> {
  const orphanedFunctionOutput = isOrphanedFunctionCallOutputError(error);
  if (
    (!isInvalidEncryptedContentError(error) && !orphanedFunctionOutput) ||
    attempt.kind === "compaction-stripped"
  ) {
    return undefined;
  }
  if (
    !orphanedFunctionOutput &&
    (attempt.kind === "initial" || attempt.kind === "continuation-rejected")
  ) {
    const reasoningStripped = stripResponsesRequestEncryptedReasoning(attempt.request);
    if (reasoningStripped !== attempt.request) {
      return { kind: "reasoning-stripped", request: reasoningStripped };
    }
  }
  const locallyStripped = stripResponsesRequestCompaction(attempt.request);
  if (locallyStripped === attempt.request) {
    return undefined;
  }
  // Filtering the already-pruned checkpoint request would leave a context-blind
  // suffix. Rebuild full history lazily, then preserve any earlier reasoning strip.
  let compactionStripped = await options.buildFullHistoryRequest();
  compactionStripped = stripResponsesRequestCompaction(compactionStripped);
  if (attempt.kind === "reasoning-stripped") {
    compactionStripped = stripResponsesRequestEncryptedReasoning(compactionStripped);
  }
  return {
    kind: "compaction-stripped",
    request: compactionStripped,
    rejectedCompaction: readOpenAIResponsesCompactionRejection(attempt.request),
  };
}

export async function createResponsesStreamWithRecovery(params: {
  client: ResponsesClientLike;
  request: OpenAIResponsesRequestParams;
  requestOptions: { signal?: AbortSignal; headers?: Record<string, string> } | undefined;
  model: Model;
  encodeBody?: ReturnType<typeof prepareModelRequestBody>;
  observePrompt?: NonNullable<ReturnType<typeof createResponsesPromptEgressObserver>>;
  initialAttemptKind?: ResponsesEncryptedContentAttemptKind;
  initialRejectedCompaction?: CompactionReplayRejection;
  onCompactionRejected?: (checkpoint: CompactionReplayRejection) => void;
  canRetryStream?: () => boolean;
  onServiceTierRejected?: (tier: "ultrafast" | "priority") => void;
  wrapStream?: (result: {
    stream: AsyncIterable<unknown>;
    response: Response;
    attempt: ResponsesEncryptedContentAttempt<OpenAIResponsesRequestParams>;
  }) => AsyncIterable<unknown>;
  buildFullHistoryRequest: () =>
    | OpenAIResponsesRequestParams
    | Promise<OpenAIResponsesRequestParams>;
}): Promise<{
  stream: AsyncIterable<unknown>;
}> {
  async function* streamWithTerminalDrain(response: Response, body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    let terminal = false;
    let firstFrame = true;
    try {
      // This owner keeps the reader for terminal draining; framing only borrows reads.
      frames: for await (const { frame } of iterateSseFrames(() => reader.read())) {
        let eventName: string | null = null;
        let data: string | undefined;
        let start = 0;
        let cr = frame.indexOf("\r");
        let lf = frame.indexOf("\n");
        while (start < frame.length) {
          const end = cr < 0 ? (lf < 0 ? frame.length : lf) : lf < 0 ? cr : Math.min(cr, lf);
          // The SDK strips one BOM per line; the decoder already handled the stream's first.
          const bom = !(firstFrame && start === 0) && frame.charCodeAt(start) === 0xfeff;
          const lineStart = bom ? start + 1 : start;
          start = end + (frame[end] === "\r" && frame[end + 1] === "\n" ? 2 : 1);
          if (cr >= 0 && cr < start) {
            cr = frame.indexOf("\r", start);
          }
          if (lf >= 0 && lf < start) {
            lf = frame.indexOf("\n", start);
          }
          if (lineStart < end) {
            const fieldLength = frame.startsWith("data", lineStart)
              ? 4
              : frame.startsWith("event", lineStart)
                ? 5
                : 0;
            const colon = lineStart + fieldLength;
            if (fieldLength && (colon === end || frame[colon] === ":")) {
              const value =
                colon === end ? "" : frame.slice(colon + (frame[colon + 1] === " " ? 2 : 1), end);
              if (fieldLength === 5) {
                eventName = value;
              } else {
                data = data === undefined ? value : `${data}\n${value}`;
              }
            }
            if (start < frame.length) {
              continue;
            }
          }
          if (!eventName && data === undefined) {
            continue;
          }
          if (data === "[DONE]") {
            break frames;
          }
          let event: unknown;
          try {
            event = JSON.parse(data ?? "");
          } catch {
            throw new SyntaxError("Error reading response: malformed server-sent event JSON.");
          }
          if (eventName?.startsWith("thread.")) {
            event = { event: eventName, data: event };
          } else if (eventName === "error" || (isRecord(event) && event.error)) {
            throw new APIError(
              undefined,
              // @ts-expect-error SDK SSE also passes arbitrary JSON; preserve scalar/null error payloads.
              isRecord(event) ? (event.error ?? event) : event,
              undefined,
              response.headers,
            );
          }
          terminal ||=
            isRecord(event) &&
            (event.type === "response.completed" || event.type === "response.incomplete");
          yield event;
          eventName = null;
          data = undefined;
        }
        firstFrame = false;
      }
    } catch (error) {
      // Match SDK transport cancellation without swallowing provider API errors.
      if (
        error instanceof APIError ||
        !isRecord(error) ||
        (error.name !== "AbortError" &&
          !String(error.message).includes("FetchRequestCanceledException"))
      ) {
        throw error;
      }
    } finally {
      if (!terminal) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      } else {
        const controller = new AbortController();
        const unregister = registerSessionResourceCleanup((sessionId) => {
          if (!sessionId) {
            controller.abort();
          }
        });
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(250),
          ...(params.requestOptions?.signal ? [params.requestOptions.signal] : []),
        ]);
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        void (async () => {
          try {
            let bytes = 0;
            while (!signal.aborted && bytes < 64 * 1024) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              bytes += value.byteLength;
            }
          } catch {
            /* Disposal must not change the delivered terminal result. */
          } finally {
            cancel();
            reader.releaseLock();
            signal.removeEventListener("abort", cancel);
            unregister();
          }
        })();
      }
    }
  }

  const encodeBody = params.encodeBody ?? prepareModelRequestBody(undefined);
  let tierCeiling: "priority" | "default" | undefined;
  const limitTier = (request: OpenAIResponsesRequestParams) =>
    tierCeiling &&
    (request.service_tier === "ultrafast" ||
      (tierCeiling === "default" && request.service_tier === "priority"))
      ? { ...request, service_tier: tierCeiling }
      : request;
  const recoverServiceTier = (
    attempt: ResponsesEncryptedContentAttempt<OpenAIResponsesRequestParams>,
    error: unknown,
  ): typeof attempt | undefined => {
    if (
      params.requestOptions?.signal?.aborted ||
      !supportsNativeOpenAIResponsesEndpoint(params.model)
    ) {
      return undefined;
    }
    const tier = attempt.request.service_tier;
    const next = nextResponsesServiceTier(tier, error);
    if (!next || (tier !== "ultrafast" && tier !== "priority")) {
      return undefined;
    }
    tierCeiling = next;
    params.onServiceTierRejected?.(tier);
    log.info(`[responses] rejected ${tier} tier; retrying with ${next}`);
    return { ...attempt, request: { ...attempt.request, service_tier: next } };
  };
  const send = async (
    initialAttempt: ResponsesEncryptedContentAttempt<OpenAIResponsesRequestParams>,
  ) => {
    let attempt = initialAttempt;
    for (;;) {
      const cappedRequest = limitTier(attempt.request);
      if (cappedRequest !== attempt.request) {
        attempt = {
          kind: attempt.kind,
          request: cappedRequest,
          rejectedCompaction: attempt.rejectedCompaction,
        };
      }
      // Observer failures are not provider rejections and must never enter recovery.
      params.observePrompt?.(attempt.request, {
        egress: "responses-sdk",
        payloadVariant: attempt.kind,
      });
      const bodyOptions = await encodeBody(attempt.request);
      let responseAccepted = false;
      try {
        const { data, response } = await params.client.responses
          .create(attempt.request as never, {
            ...params.requestOptions,
            ...bodyOptions,
            headers: { ...bodyOptions.headers, ...params.requestOptions?.headers },
          })
          .withResponse();
        responseAccepted = true;
        // Commit a resolved attempt before rejecting a non-stream response.
        commitResponsesEncryptedContentAttempt(attempt, (checkpoint) => {
          if (checkpoint) {
            params.onCompactionRejected?.(checkpoint);
          }
        });
        if (!isAsyncIterable(data)) {
          throw new Error("OpenAI Responses streaming request returned a non-stream response");
        }
        const stream =
          data instanceof Stream && response.body
            ? streamWithTerminalDrain(response, response.body)
            : data;
        return { stream, response, attempt };
      } catch (error) {
        let nextAttempt =
          (!responseAccepted ? recoverServiceTier(attempt, error) : undefined) ??
          (await resolveNextResponsesEncryptedContentAttempt(attempt, error, {
            buildFullHistoryRequest: params.buildFullHistoryRequest,
          }));
        if (
          !nextAttempt &&
          attempt.request.previous_response_id &&
          error &&
          typeof error === "object" &&
          typeof (error as { status?: unknown }).status === "number" &&
          isPreviousResponseRejection(error as { code?: unknown; param?: unknown })
        ) {
          const request = {
            ...(await params.buildFullHistoryRequest()),
          };
          delete request.previous_response_id;
          nextAttempt = { kind: "continuation-rejected", request };
        }
        if (!nextAttempt) {
          throw error;
        }
        const retryDescription =
          nextAttempt.request.service_tier !== attempt.request.service_tier
            ? "with a slower service tier"
            : nextAttempt.kind === "reasoning-stripped"
              ? "without encrypted reasoning content"
              : nextAttempt.kind === "compaction-stripped"
                ? "without encrypted compaction content"
                : "full history after rejected previous_response_id";
        log.warn(
          `[responses] retrying ${retryDescription} provider=${params.model.provider} ` +
            `api=${params.model.api} model=${params.model.id}`,
        );
        attempt = nextAttempt;
      }
    }
  };
  const result = await send({
    kind: params.initialAttemptKind ?? "initial",
    request: params.request,
    ...(params.initialRejectedCompaction
      ? { rejectedCompaction: params.initialRejectedCompaction }
      : {}),
  });
  return {
    stream: {
      async *[Symbol.asyncIterator]() {
        let current = result;
        let outputObserved = false;
        // Advance the source after rejection; retain the caller's one live parser and hooks.
        for (;;) {
          let rejectedEvent: unknown;
          let sourceError: unknown;
          const source = current.stream;
          const providerStream = {
            async *[Symbol.asyncIterator]() {
              try {
                yield* source;
              } catch (error) {
                sourceError = error;
                throw error;
              }
            },
          };
          try {
            for await (const event of params.wrapStream?.({ ...current, stream: providerStream }) ??
              providerStream) {
              const { failure, hasResponseOutput, isPrelude } = readResponsesRecoveryEvent(event);
              outputObserved ||= hasResponseOutput;
              if (
                isRecord(failure) &&
                params.canRetryStream?.() === true &&
                (isInvalidEncryptedContentError(failure) ||
                  (!outputObserved && isResponsesServiceTierRejection(failure)))
              ) {
                rejectedEvent = event;
                const message = typeof failure.message === "string" ? failure.message : "";
                throw Object.assign(new Error(message), {
                  code: failure.code,
                  status: failure.status,
                  type: failure.type,
                  param: failure.param,
                });
              }
              outputObserved ||= !isPrelude;
              yield event;
            }
            return;
          } catch (error) {
            // Hook cancellation before output must not reissue an already-cancelled request.
            const nextAttempt =
              params.canRetryStream?.() === true && !params.requestOptions?.signal?.aborted
                ? ((!outputObserved && (rejectedEvent !== undefined || sourceError === error)
                    ? recoverServiceTier(current.attempt, error)
                    : undefined) ??
                  (await resolveNextResponsesEncryptedContentAttempt(current.attempt, error, {
                    buildFullHistoryRequest: params.buildFullHistoryRequest,
                  })))
                : undefined;
            if (!nextAttempt) {
              if (rejectedEvent !== undefined) {
                yield rejectedEvent;
                return;
              }
              throw error;
            }
            log.warn(
              `[responses] retrying explicitly rejected stream provider=${params.model.provider} ` +
                `api=${params.model.api} model=${params.model.id}`,
            );
            current = await send(nextAttempt);
          }
        }
      },
    },
  };
}

export function resolveAzureOpenAIApiVersion(env = process.env): string {
  return env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

export {
  buildResponsesInputMessage,
  convertProviderResponsesMessages,
  convertResponsesMessages,
  createOpenAIResponsesAssistantOutput,
  encodeTextSignatureV1,
} from "./openai-responses-replay-messages-internal.js";
