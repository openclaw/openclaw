import type { AssistantMessage, StreamFn } from "@openclaw/llm-core";
import {
  OpenAIResponsesWebSocketSafeRetryError,
  OpenAIResponsesWebSocketPreDispatchError,
  responsesServiceTierObserver,
  type OpenAIResponsesRequestParams,
} from "./openai-responses-contracts.js";
import { safeDebugValue } from "./openai-responses-debug.js";
import {
  createResponsesStreamWithRecovery,
  isInvalidEncryptedContentError,
  readResponsesRecoveryEvent,
  resolveNextResponsesEncryptedContentAttempt,
} from "./openai-responses-replay-internal.js";
import {
  isResponsesServiceTierRejection,
  nextResponsesServiceTier,
} from "./openai-responses-service-tier.js";
import { notifyProviderStreamOpened } from "./transport-stream-shared.js";

type RecoveryParams = Parameters<typeof createResponsesStreamWithRecovery>[0];

/** Owns safe WebSocket rejection recovery; transport selection and session leases stay with the caller. */
export function createRecoverableResponsesWebSocketStream<
  TRequest extends OpenAIResponsesRequestParams,
>(params: {
  trackedWebSocketStream: AsyncIterable<unknown>;
  websocket: {
    request: Record<string, unknown>;
    readonly hasActiveResponse: boolean;
    finish: (options?: { keep?: boolean }) => void;
  };
  websocketSignal: AbortSignal;
  options: Parameters<StreamFn>[2];
  output: AssistantMessage;
  buildRequest: (mode: "full-history") => Promise<TRequest>;
  createSseStream: (
    request?: TRequest,
    kind?: RecoveryParams["initialAttemptKind"],
    rejected?: RecoveryParams["initialRejectedCompaction"],
  ) => Promise<AsyncIterable<unknown>>;
  closeWebSocketForFallback: (reason: string) => void;
  logWebSocketFallback: (reason: string) => void;
  startStream: () => void;
  setTransportToSse: () => void;
}) {
  const {
    trackedWebSocketStream,
    websocket,
    websocketSignal,
    options,
    output,
    buildRequest,
    createSseStream,
    closeWebSocketForFallback,
    logWebSocketFallback,
    startStream,
  } = params;
  return {
    async *[Symbol.asyncIterator]() {
      let acceptance: "pending" | "observing" | "accepted" = "pending";
      let outputObserved = false;
      try {
        for await (const event of trackedWebSocketStream) {
          const { failure, hasResponseOutput, isPrelude } = readResponsesRecoveryEvent(event);
          outputObserved ||= hasResponseOutput;
          if (isResponsesServiceTierRejection(failure) && !websocket.hasActiveResponse) {
            throw new OpenAIResponsesWebSocketSafeRetryError(
              "invalid_request_error",
              undefined,
              "service_tier",
              "Invalid service_tier argument",
              failure,
            );
          }
          outputObserved ||= !isPrelude;
          if (acceptance === "pending") {
            acceptance = "observing";
            await notifyProviderStreamOpened({
              options,
              cancelStream: () => websocket.finish({ keep: false }),
            });
            acceptance = "accepted";
          }
          startStream();
          yield event;
        }
      } catch (error) {
        if (error instanceof OpenAIResponsesWebSocketSafeRetryError) {
          if (isResponsesServiceTierRejection(error)) {
            const nextTier = nextResponsesServiceTier(websocket.request.service_tier, error);
            if (
              !nextTier ||
              outputObserved ||
              acceptance === "observing" ||
              output.content.length ||
              websocketSignal.aborted ||
              websocket.hasActiveResponse
            ) {
              throw error;
            }
            closeWebSocketForFallback("service_tier_rejected");
            const rejectedTier = websocket.request.service_tier;
            if (rejectedTier === "ultrafast" || rejectedTier === "priority") {
              responsesServiceTierObserver.reject(options, rejectedTier);
            }
            yield* await createSseStream({
              ...(await buildRequest("full-history")),
              service_tier: nextTier,
            });
            return;
          }
          // Explicit server rejection proves no output was accepted. Resume at the next
          // semantic attempt instead of treating this like an ambiguous disconnect.
          const encryptedContentRejected = isInvalidEncryptedContentError(error);
          const recovery = encryptedContentRejected
            ? await resolveNextResponsesEncryptedContentAttempt(
                {
                  kind: "initial",
                  // SAFETY: This is the caller's prepared request; WebSocket sanitization only removed `stream`.
                  request: { ...websocket.request, stream: true } as TRequest,
                },
                error,
                { buildFullHistoryRequest: () => buildRequest("full-history") },
              )
            : undefined;
          if (encryptedContentRejected && !recovery) {
            throw error;
          }
          closeWebSocketForFallback(
            `safe_server_error code=${error.code} status=${safeDebugValue(error.status)} param=${safeDebugValue(error.param)}`,
          );
          yield* await createSseStream(
            recovery?.request ?? (await buildRequest("full-history")),
            recovery?.kind ?? "continuation-rejected",
            recovery?.rejectedCompaction,
          );
          return;
        }
        if (
          websocketSignal.aborted ||
          !(error instanceof OpenAIResponsesWebSocketPreDispatchError)
        ) {
          throw error;
        }
        params.setTransportToSse();
        logWebSocketFallback("before_first_event");
        yield* await createSseStream();
      }
    },
  };
}
