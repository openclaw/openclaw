const DEFAULT_SSE_STREAM_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

export interface SdkBoundedFetchOptions {
  /** Maximum cumulative bytes for an SSE stream body. Default 16 MiB. */
  maxBytes?: number;
}

/**
 * Wraps `innerFetch` (defaults to `globalThis.fetch`) to cap SSE response
 * body reads at `maxBytes`. Non-SSE responses pass through unchanged.
 *
 * The cap is cumulative across the entire stream, not per-chunk. When the
 * cumulative byte count exceeds `maxBytes`, the upstream stream is cancelled
 * and the downstream consumer receives an error.
 *
 * The bound uses a simple "runoff" check rather than buffering: every chunk
 * from the inner stream is counted and passed through. No partial chunk is
 * split at the boundary — a single chunk can push the total over the cap.
 * This is acceptable for SSE streams because even a single 16 MiB+ chunk
 * implies a hostile or buggy endpoint.
 */
export function createSdkBoundedFetch(
  innerFetch: typeof fetch = globalThis.fetch,
  options: SdkBoundedFetchOptions = {},
): typeof fetch {
  const maxBytes = options.maxBytes ?? DEFAULT_SSE_STREAM_MAX_BYTES;

  return async (input, init) => {
    const response = await innerFetch(input, init);

    // Only bound SSE streaming responses. Non-SSE responses (JSON, text,
    // binary) are bounded by readProviderJsonResponse / readProviderTextResponse
    // and similar helpers elsewhere.
    if (!response.body || !isSseContentType(response.headers.get("content-type") ?? "")) {
      return response;
    }
    // Also skip error-status SSE responses — they tend to be small error details.
    if (!response.ok) {
      return response;
    }

    const boundedBody = createBoundedStream(response.body, maxBytes);

    return new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function isSseContentType(contentType: string): boolean {
  return /\btext\/event-stream\b/i.test(contentType);
}

/**
 * Wraps `source` in a transform stream that cancels the upstream after
 * `maxBytes` cumulative bytes have been delivered. Downstream consumers
 * receive a stream error when the limit is exceeded.
 */
function createBoundedStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let totalBytes = 0;
  const reader = source.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          controller.error(
            Object.assign(new Error(`SSE stream exceeded maximum size of ${maxBytes} bytes`), {
              code: "SSE_STREAM_TOO_LARGE" satisfies string,
              maxBytes,
            }),
          );
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

export const testing = {
  DEFAULT_SSE_STREAM_MAX_BYTES,
  isSseContentType,
};
