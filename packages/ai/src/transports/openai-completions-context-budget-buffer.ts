import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";

// Bound provider chunks, not repeated cumulative assistant snapshots. A normal
// multi-token reasoning response otherwise exhausts the event buffer quadratically.
const MAX_CONTEXT_BUDGET_BUFFER_CHUNKS = 8_192;
const MAX_CONTEXT_BUDGET_BUFFER_BYTES = 4 * 1_024 * 1_024;

export async function bufferContextLimitedCompletions(
  source: AsyncIterable<ChatCompletionChunk>,
  options?: { signal?: AbortSignal; onChunk?: () => void },
): Promise<{
  stream: AsyncIterable<ChatCompletionChunk>;
  bounded: boolean;
  failed: boolean;
  finishReason: string | undefined;
}> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: ChatCompletionChunk[] = [];
  let bufferedBytes = 0;
  let overflow: IteratorYieldResult<ChatCompletionChunk> | undefined;
  let finished = false;
  let failed = false;
  let sourceError: unknown;
  let finishReason: string | undefined;
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        finished = true;
        break;
      }
      const chunk = next.value;
      if (chunk && typeof chunk === "object") {
        options?.onChunk?.();
      }
      const chunkBytes = Buffer.byteLength(JSON.stringify(chunk) ?? "", "utf8");
      if (
        chunks.length >= MAX_CONTEXT_BUDGET_BUFFER_CHUNKS ||
        bufferedBytes + chunkBytes > MAX_CONTEXT_BUDGET_BUFFER_BYTES
      ) {
        overflow = next;
        break;
      }
      chunks.push(chunk);
      bufferedBytes += chunkBytes;
      const chunkFinishReason = chunk?.choices?.[0]?.finish_reason;
      if (chunkFinishReason) {
        finishReason = chunkFinishReason;
      }
      options?.signal?.throwIfAborted();
    }
  } catch (error) {
    failed = true;
    sourceError = error;
    // Replay the received prefix into the reducer before surfacing this error,
    // retaining real provider usage without publishing incomplete candidate tools.
    void iterator.return?.().catch(() => undefined);
  }
  const bounded = overflow === undefined;
  return {
    bounded,
    failed,
    finishReason,
    stream: {
      async *[Symbol.asyncIterator]() {
        try {
          yield* chunks;
          if (failed) {
            throw sourceError;
          }
          if (overflow !== undefined) {
            yield overflow.value;
            for (;;) {
              const next = await iterator.next();
              if (next.done) {
                finished = true;
                return;
              }
              yield next.value;
            }
          }
        } finally {
          chunks.length = 0;
          if (!finished && !failed) {
            void iterator.return?.().catch(() => undefined);
          }
        }
      },
    },
  };
}
