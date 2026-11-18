import { createSseByteGuard } from "../utils/streaming-byte-guard.js";
import { COMPACTION_WINDOW_MAX_BYTES } from "./openai-responses-compaction-checkpoint.js";

export {
  getResponsesCompactionInputIdentity,
  publishResponsesCompactionInput,
  tagResponsesCompactionInput,
  isOpenAIResponsesCompactionOutput,
  getOpenAIResponsesCompactionOutputError,
  getOpenAIResponsesCompactionWindowReplayBytesAvailable,
  readOpenAIResponsesCompactionWindow,
  type OpenAIResponsesCompactionOutput,
  type OpenAIResponsesCompactedWindow,
} from "./openai-responses-compaction-checkpoint.js";

/** Bound success bytes while leaving body deadlines, retries, and parsing to the SDK. */
export function createBoundedOpenAIResponsesCompactionFetch(
  upstreamFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await upstreamFetch(input, init);
    if (!response.ok || !response.body) {
      return response;
    }
    const reader = response.body.getReader();
    const guard = createSseByteGuard(reader, {
      maxBytes: COMPACTION_WINDOW_MAX_BYTES,
      onOverflow: () => new Error("Responses compact endpoint response exceeds 16 MiB"),
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await guard.read();
          if (chunk.done) {
            reader.releaseLock();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          reader.releaseLock();
          controller.error(error);
        }
      },
      cancel(reason) {
        // Cancellation may never settle; it must not hold the SDK's timeout outcome.
        void guard.cancel(reason);
        reader.releaseLock();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
