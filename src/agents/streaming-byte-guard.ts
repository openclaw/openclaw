/**
 * Bounded SSE / NDJSON stream reader guard.
 *
 * Wraps a `ReadableStreamDefaultReader<Uint8Array>` so the caller can keep its
 * existing chunk-by-chunk parsing logic untouched, while accumulated bytes are
 * tracked against a hard byte cap. On overflow the underlying reader is
 * cancelled and an overflow error is thrown — the same shape Alix-007's
 * non-streaming `readProviderJsonResponse` / `readResponseWithLimit` helper
 * family uses for JSON / binary / text bodies.
 *
 * SSE / NDJSON streaming bodies are attacker-influenceable on every Anthropic-
 * compatible, OpenAI, Ollama, Google, and proxy endpoint; a hostile or
 * malfunctioning server can stream forever and exhaust process memory. This
 * guard closes the symmetric success-path surface that the previous bounded
 * helpers left open (they covered `response.json()` / `response.text()` for
 * non-streaming bodies only).
 *
 * Internal for now: only Anthropic transport + provider call sites consume
 * it. When an external plugin (e.g. extensions/google, extensions/ollama)
 * needs the same byte-cap guard, promote this helper through the
 * `openclaw/plugin-sdk/*` surface together with `scripts/lib/plugin-sdk-entrypoints.json`
 * and the API-baseline hash so the SDK contract stays aligned.
 */

export type SseStreamOverflow = {
  size: number;
  maxBytes: number;
};

export type ReadSseStreamWithLimitOptions = {
  maxBytes: number;
  onOverflow?: (params: SseStreamOverflow) => Error;
};

export type SseByteGuard = {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(reason?: unknown): Promise<void>;
  totalBytes(): number;
  overflowed(): boolean;
};

/**
 * Wrap a `ReadableStreamDefaultReader<Uint8Array>` so accumulated bytes are
 * capped. After overflow the wrapper throws on every subsequent read and the
 * underlying reader is cancelled so the upstream producer stops immediately.
 *
 * Usage:
 *
 *   const reader = body.getReader();
 *   const guard = createSseByteGuard(reader, { maxBytes: 16 * 1024 * 1024 });
 *   while (true) {
 *     const { done, value } = await guard.read();
 *     if (done) break;
 *     // existing line / frame parsing logic, untouched
 *   }
 */
export function createSseByteGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: ReadSseStreamWithLimitOptions,
): SseByteGuard {
  if (!Number.isFinite(opts.maxBytes) || opts.maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative finite number: ${opts.maxBytes}`);
  }
  const onOverflow =
    opts.onOverflow ??
    ((params: SseStreamOverflow) =>
      new Error(`SSE stream exceeds ${params.maxBytes} bytes (received ${params.size})`));

  let total = 0;
  let cancelled = false;

  return {
    read: async () => {
      if (cancelled) {
        return { done: true, value: undefined };
      }
      const result = await reader.read();
      if (result.done) {
        return result;
      }
      const chunk = result.value;
      const chunkLen = chunk?.byteLength ?? 0;
      const next = total + chunkLen;
      if (next > opts.maxBytes) {
        cancelled = true;
        const err = onOverflow({ size: next, maxBytes: opts.maxBytes });
        try {
          await reader.cancel(err);
        } catch {
          // ignore cancellation failures — caller sees the overflow error
        }
        throw err;
      }
      total = next;
      return result;
    },
    cancel: async (reason?: unknown) => {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } catch {
        // ignore cancellation failures
      }
    },
    totalBytes: () => total,
    overflowed: () => cancelled,
  };
}
