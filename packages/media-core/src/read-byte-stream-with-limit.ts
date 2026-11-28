/** Details passed to byte-stream overflow error factories. */
export type ByteStreamLimitOverflow = {
  size: number;
  maxBytes: number;
};

/** Options for reading an async byte stream under a hard byte cap. */
export type ReadByteStreamWithLimitOptions = {
  maxBytes: number;
  onOverflow?: (params: ByteStreamLimitOverflow) => Error;
  /** Ambient cancellation: aborting destroys the upstream stream and rejects with AbortError. */
  signal?: AbortSignal;
};

function destroyReadableOnOverflow(stream: unknown, err: Error): void {
  const readable = stream as {
    destroy?: () => unknown;
    cancel?: (reason?: unknown) => unknown;
  };
  // Stop upstream producers immediately after overflow; otherwise large media
  // streams can continue buffering after the caller has already failed.
  if (typeof readable.destroy === "function") {
    try {
      // The helper already throws the overflow error to its caller. Passing the
      // same error to destroy() also emits it on Node streams, which can become
      // an unrelated uncaught exception after the awaited rejection settles.
      readable.destroy();
    } catch {}
    return;
  }
  if (typeof readable.cancel === "function") {
    try {
      void Promise.resolve(readable.cancel(err)).catch(() => undefined);
    } catch {}
  }
}

function createAbortError(signal: AbortSignal): Error {
  return new DOMException(
    signal.reason instanceof Error ? signal.reason.message : "The operation was aborted",
    "AbortError",
  );
}

function destroyReadableOnAbort(stream: unknown, signal: AbortSignal): void {
  // Stop upstream producers so a held-open stdin/body stops buffering and the
  // awaited `for await` loop settles instead of waiting for a late EOF.
  destroyReadableOnOverflow(stream, createAbortError(signal));
}

/**
 * Registers {@code handler} for the remaining lifetime of an optional ambient
 * signal and returns its detach handle. Checking presence here keeps callers on
 * the narrowed signal instead of asserting it back to {@link AbortSignal}.
 */
function registerAbortHandler(
  signal: AbortSignal | undefined,
  handler: (signal: AbortSignal) => void,
): () => void {
  if (!signal) {
    return () => {};
  }
  const abortSignal = signal;
  const listener = () => handler(abortSignal);
  abortSignal.addEventListener("abort", listener, { once: true });
  return () => abortSignal.removeEventListener("abort", listener);
}

/**
 * A WHATWG {@link ReadableStream} as seen by this reader: it exposes
 * {@code getReader} and lacks Node's {@code destroy}. Carrying this checked
 * shape means the Web branch below can call {@code getReader()} without a
 * chained assertion that discards type evidence.
 */
type WebReadableStream = AsyncIterable<unknown> & {
  getReader(): ReadableStreamDefaultReader<unknown>;
  destroy?: unknown;
};

/**
 * Returns true when {@link stream} is a WHATWG {@link ReadableStream} (has
 * {@code getReader} and no Node {@code destroy}). Async iteration locks such a
 * stream, so abort cannot settle a held-open read through {@code cancel()};
 * the reader branch below reads through an owned reader it can cancel.
 */
function isWebReadableStream(stream: AsyncIterable<unknown>): stream is WebReadableStream {
  if (!("getReader" in stream) || typeof stream.getReader !== "function") {
    return false;
  }
  return !("destroy" in stream) || typeof stream.destroy !== "function";
}

/** Normalizes a single byte-stream chunk into a {@link Buffer}, rejecting unknown types. */
function toBufferChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError(`Unsupported byte stream chunk: ${typeof chunk}`);
}

/**
 * Reads a WHATWG {@link ReadableStream} through an owned reader so an abort can
 * {@code reader.cancel()} a held-open read instead of waiting for a late EOF.
 */
async function readWebReadableStreamWithLimit(
  stream: WebReadableStream,
  opts: ReadByteStreamWithLimitOptions,
): Promise<Buffer> {
  const { maxBytes, signal } = opts;
  const onOverflow =
    opts.onOverflow ??
    ((params: ByteStreamLimitOverflow) =>
      new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
  signal?.throwIfAborted();
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  const detachAbort = registerAbortHandler(signal, (abortSignal) => {
    void Promise.resolve(reader.cancel(createAbortError(abortSignal))).catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        break;
      }
      const buffer = toBufferChunk(value);
      if (buffer.byteLength === 0) {
        continue;
      }
      const nextTotal = total + buffer.byteLength;
      if (nextTotal > maxBytes) {
        const err = onOverflow({ size: nextTotal, maxBytes });
        void Promise.resolve(reader.cancel(err)).catch(() => undefined);
        throw err;
      }
      chunks.push(buffer);
      total = nextTotal;
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    // The abort listener cancels the owned reader, which settles a held-open
    // read with an AbortError instead of a late EOF. Surface that as the
    // cancellation the caller asked us to observe rather than a stream detail.
    signal?.throwIfAborted();
    throw error;
  } finally {
    detachAbort();
    reader.releaseLock();
  }
}

/** Reads and concatenates an async byte stream, throwing once the byte cap is exceeded. */
export async function readByteStreamWithLimit(
  stream: AsyncIterable<unknown>,
  opts: ReadByteStreamWithLimitOptions,
): Promise<Buffer> {
  const { maxBytes, signal } = opts;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative finite number: ${maxBytes}`);
  }

  if (isWebReadableStream(stream)) {
    return readWebReadableStreamWithLimit(stream, opts);
  }

  const onOverflow =
    opts.onOverflow ??
    ((params: ByteStreamLimitOverflow) =>
      new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
  signal?.throwIfAborted();
  const chunks: Buffer[] = [];
  let total = 0;

  const detachAbort = registerAbortHandler(signal, (abortSignal) =>
    destroyReadableOnAbort(stream, abortSignal),
  );
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const buffer = toBufferChunk(chunk);
      if (buffer.byteLength === 0) {
        continue;
      }
      const nextTotal = total + buffer.byteLength;
      if (nextTotal > maxBytes) {
        const err = onOverflow({ size: nextTotal, maxBytes });
        destroyReadableOnOverflow(stream, err);
        throw err;
      }
      chunks.push(buffer);
      total = nextTotal;
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    // The abort listener destroys the upstream stream, which settles a held-open
    // read with a stream error instead of a late EOF. Surface that as the
    // cancellation the caller asked us to observe rather than a stream detail.
    signal?.throwIfAborted();
    throw error;
  } finally {
    detachAbort();
  }
}
