/** Bounds cumulative stream bytes without waiting for reader cleanup after overflow. */
export type SseStreamOverflow = {
  size: number;
  maxBytes: number;
};

export type ReadSseStreamWithLimitOptions = {
  maxBytes: number;
  onOverflow?: (params: SseStreamOverflow) => Error;
};

export function createSseByteGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: ReadSseStreamWithLimitOptions,
) {
  if (!Number.isFinite(opts.maxBytes) || opts.maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative finite number: ${opts.maxBytes}`);
  }
  const onOverflow =
    opts.onOverflow ??
    ((params) =>
      new Error(`SSE stream exceeds ${params.maxBytes} bytes (received ${params.size})`));
  let total = 0;
  let overflowedFlag = false;
  let cancelledFlag = false;
  const cancelReaderBestEffort = (reason?: unknown): void => {
    // Upstream cancellation may never settle; cleanup cannot gate the primary outcome.
    void reader.cancel(reason).catch(() => undefined);
  };
  return {
    read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (overflowedFlag || cancelledFlag) {
        return { done: true, value: undefined };
      }
      const result = await reader.read();
      if (result.done) {
        return result;
      }
      const chunkLen = result.value?.byteLength ?? 0;
      const next = total + chunkLen;
      if (next > opts.maxBytes) {
        overflowedFlag = true;
        cancelledFlag = true;
        const err = onOverflow({ size: next, maxBytes: opts.maxBytes });
        cancelReaderBestEffort(err);
        throw err;
      }
      total = next;
      return result;
    },
    cancel: async (reason?: unknown) => {
      if (overflowedFlag) {
        // overflow already set cancelledFlag; do not overwrite
        return;
      }
      cancelledFlag = true;
      cancelReaderBestEffort(reason);
    },
    totalBytes: () => total,
    overflowed: () => overflowedFlag,
    cancelled: () => cancelledFlag,
  };
}
