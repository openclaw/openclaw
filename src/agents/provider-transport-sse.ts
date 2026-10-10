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

export function findSseEventBoundary(
  buffer: string,
  startIndex = 0,
): { index: number; length: number } | undefined {
  const delimiter = /\r\n\r\n|\n\n|\r\r/g;
  delimiter.lastIndex = startIndex;
  const match = delimiter.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

export async function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): Promise<void> {
  // Reader cancellation is cleanup. An upstream cancel failure must not replace
  // the wrapper's authoritative stream error or downstream cancellation.
  await reader.cancel(reason).catch(() => undefined);
}

function capNonOkResponseBodyLazily(response: Response, maxBytes: number): Response {
  const source = response.body;
  if (!source) {
    return response;
  }
  const reader = source.getReader();
  let total = 0;
  // Own the reader: Node can leak an internal pipeThrough writer rejection when
  // downstream cancellation races the cap terminating the transform.
  const capped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
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

export function prepareOpenAISdkSseResponse(
  response: Response,
  options: { sanitize: boolean; synthesizeJsonAsSse: boolean; onSseComment?: () => void },
): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.body) {
    return response;
  }
  if (!response.ok) {
    return options.sanitize
      ? capNonOkResponseBodyLazily(response, SSE_NONOK_BODY_MAX_BYTES)
      : response;
  }
  const synthesizeJson =
    options.sanitize && options.synthesizeJsonAsSse && isProviderJsonContentType(contentType);
  const isSse = /\btext\/event-stream\b/i.test(contentType);
  if (!synthesizeJson && !(isSse && (options.sanitize || options.onSseComment))) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  let buffer = "";
  let scanOffset = 0;
  let totalBytes = 0;
  // Undefined means the next character starts a line.
  let commentLine: boolean | undefined;

  const enqueueSanitized = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    for (;;) {
      const boundary = findSseEventBoundary(buffer, scanOffset);
      if (!boundary) {
        // A delimiter can straddle chunks; only its last three characters need revisiting.
        scanOffset = Math.max(0, buffer.length - 3);
        if (buffer.length > SSE_SANITIZE_BUFFER_MAX_CHARS) {
          throw new Error(
            `SSE response exceeded max buffer size (${SSE_SANITIZE_BUFFER_MAX_CHARS} chars) without event boundary`,
          );
        }
        return false;
      }
      const block = buffer.slice(0, boundary.index + boundary.length);
      buffer = buffer.slice(boundary.index + boundary.length);
      scanOffset = 0;
      // OpenAI's SDK tries to JSON.parse event-only or blank-data SSE messages.
      if (hasReadableSseData(block)) {
        controller.enqueue(encoder.encode(block));
        return true;
      }
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (!synthesizeJson && options.sanitize && enqueueSanitized(controller)) {
            return;
          }
          const chunk = await reader.read();
          if (chunk.done) {
            buffer += decoder.decode();
            if (synthesizeJson) {
              const data = buffer.trim();
              if (data) {
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } else if (options.sanitize && hasReadableSseData(buffer)) {
              controller.enqueue(encoder.encode(buffer));
            }
            buffer = "";
            controller.close();
            return;
          }
          if (synthesizeJson) {
            totalBytes += chunk.value.byteLength;
            if (totalBytes > SSE_SYNTHESIZE_JSON_MAX_BYTES) {
              throw new Error(
                `Streaming JSON body exceeded ${SSE_SYNTHESIZE_JSON_MAX_BYTES} bytes while synthesizing SSE frames`,
              );
            }
          }
          const text = decoder.decode(chunk.value, { stream: true });
          // Observe complete comment lines even without event separators. Keep only
          // line state, so an unbounded comment cannot grow observer memory.
          if (isSse && options.onSseComment) {
            for (const char of text) {
              if (char === "\n" || char === "\r") {
                if (commentLine) {
                  options.onSseComment();
                }
                commentLine = undefined;
              } else {
                commentLine ??= char === ":";
              }
            }
          }
          if (!options.sanitize) {
            controller.enqueue(chunk.value);
            return;
          }
          buffer += text;
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
  const prepared = new Response(body, response);
  if (synthesizeJson) {
    prepared.headers.set("content-type", "text/event-stream; charset=utf-8");
  }
  return prepared;
}

export function isProviderJsonContentType(contentType: string): boolean {
  return /\bapplication\/json\b/i.test(contentType) || /\+json\b/i.test(contentType);
}
