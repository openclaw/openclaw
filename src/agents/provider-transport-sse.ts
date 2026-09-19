/** Max bytes for an entire JSON body synthesized into SSE frames. Prevents OOM
 *  when a hostile streaming endpoint returns a never-ending JSON response
 *  without Content-Length. */
const SSE_SYNTHESIZE_JSON_MAX_BYTES = 16 * 1024 * 1024;

/** Max bytes read from a non-OK response body before truncation. */
const SSE_NONOK_BODY_MAX_BYTES = 64 * 1024;

/** Max decoded characters buffered while waiting for the next SSE event boundary. */
const SSE_SANITIZE_BUFFER_MAX_CHARS = 16 * 1024 * 1024;

export function hasReadableSseData(block: string): boolean {
  return block
    .split(/\r\n|\n|\r/)
    .some((line) => line.startsWith("data:") && line.slice("data:".length).trim().length > 0);
}

function hasSseComment(block: string): boolean {
  return block.split(/\r\n|\n|\r/).some((line) => line.startsWith(":"));
}

export function findSseEventBoundary(
  buffer: string,
): { index: number; length: number } | undefined {
  let best: { index: number; length: number } | undefined;
  for (const delimiter of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const index = buffer.indexOf(delimiter);
    if (index === -1) {
      continue;
    }
    if (!best || index < best.index) {
      best = { index, length: delimiter.length };
    }
  }
  return best;
}

export async function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  reason?: unknown,
): Promise<void> {
  // Reader cancellation is cleanup. An upstream cancel failure must not replace
  // the wrapper's authoritative stream error or downstream cancellation.
  await reader?.cancel(reason).catch(() => undefined);
}

function capNonOkResponseBodyLazily(response: Response, maxBytes: number): Response {
  const source = response.body;
  if (!source) {
    return response;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let total = 0;
  // Own the reader: Node can leak an internal pipeThrough writer rejection when
  // downstream cancellation races the cap terminating the transform.
  const capped = new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) {
          controller.close();
          return;
        }
        const remaining = maxBytes - total;
        if (chunk.value.byteLength > remaining) {
          if (remaining > 0) {
            controller.enqueue(chunk.value.subarray(0, remaining));
          }
          total = maxBytes;
          controller.close();
          void cancelReaderBestEffort(reader);
          return;
        }
        total += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        void cancelReaderBestEffort(reader, error);
      }
    },
    async cancel(reason) {
      await cancelReaderBestEffort(reader, reason);
    },
  });
  return new Response(capped, response);
}

export function sanitizeOpenAISdkSseResponse(
  response: Response,
  options?: { synthesizeJsonAsSse?: boolean; onSseComment?: () => void },
): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body) {
    return response;
  }
  if (!response.ok) {
    return capNonOkResponseBodyLazily(response, SSE_NONOK_BODY_MAX_BYTES);
  }
  if (
    options?.synthesizeJsonAsSse === true &&
    (/\bapplication\/json\b/i.test(contentType) || /\+json\b/i.test(contentType))
  ) {
    const source = response.body;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let buffer = "";
    let totalBytes = 0;
    const sseBody = new ReadableStream<Uint8Array>({
      start() {
        reader = source.getReader();
      },
      async pull(controller) {
        try {
          for (;;) {
            const chunk = await reader?.read();
            if (!chunk || chunk.done) {
              buffer += decoder.decode();
              const data = buffer.trim();
              if (data) {
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            const nextTotalBytes = totalBytes + chunk.value.byteLength;
            if (nextTotalBytes > SSE_SYNTHESIZE_JSON_MAX_BYTES) {
              throw new Error(
                `Streaming JSON body exceeded ${SSE_SYNTHESIZE_JSON_MAX_BYTES} bytes while synthesizing SSE frames`,
              );
            }
            totalBytes = nextTotalBytes;
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        } catch (error) {
          await cancelReaderBestEffort(reader, error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        await cancelReaderBestEffort(reader, reason);
      },
    });
    const headers = new Headers(response.headers);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(sseBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!/\btext\/event-stream\b/i.test(contentType)) {
    return response;
  }

  const source = response.body;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let buffer = "";

  const enqueueSanitized = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ): number => {
    let enqueued = 0;
    buffer += text;
    for (;;) {
      const boundary = findSseEventBoundary(buffer);
      if (!boundary) {
        if (buffer.length > SSE_SANITIZE_BUFFER_MAX_CHARS) {
          throw new Error(
            `SSE response exceeded max buffer size (${SSE_SANITIZE_BUFFER_MAX_CHARS} chars) without event boundary`,
          );
        }
        return enqueued;
      }
      const block = buffer.slice(0, boundary.index);
      const separator = buffer.slice(boundary.index, boundary.index + boundary.length);
      buffer = buffer.slice(boundary.index + boundary.length);
      // OpenAI's SDK currently tries to JSON.parse event-only or blank-data SSE
      // messages. Drop those malformed keepalive-style blocks before it parses.
      if (hasReadableSseData(block)) {
        controller.enqueue(encoder.encode(`${block}${separator}`));
        enqueued += 1;
        return enqueued;
      }
      if (hasSseComment(block)) {
        options?.onSseComment?.();
      }
    }
  };

  const sanitizedBody = new ReadableStream<Uint8Array>({
    start() {
      reader = source.getReader();
    },
    async pull(controller) {
      try {
        for (;;) {
          const pending = enqueueSanitized(controller, "");
          if (pending > 0) {
            return;
          }
          const chunk = await reader?.read();
          if (!chunk || chunk.done) {
            const tail = decoder.decode();
            if (tail) {
              enqueueSanitized(controller, tail);
            }
            if (buffer && hasReadableSseData(buffer)) {
              controller.enqueue(encoder.encode(buffer));
            }
            buffer = "";
            controller.close();
            return;
          }
          const enqueued = enqueueSanitized(
            controller,
            decoder.decode(chunk.value, { stream: true }),
          );
          if (enqueued > 0) {
            return;
          }
        }
      } catch (error) {
        await cancelReaderBestEffort(reader, error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cancelReaderBestEffort(reader, reason);
    },
  });

  return new Response(sanitizedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
