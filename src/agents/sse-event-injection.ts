/**
 * SSE event field injection for third-party Anthropic-compatible proxies.
 *
 * Some proxies serving the Anthropic Messages API return SSE streams without
 * `event:` field lines. The `@anthropic-ai/sdk` SSE parser requires `event:`
 * fields to dispatch events — without them, all events are silently dropped
 * and the stream ends with "request ended without sending any chunks".
 *
 * This module provides a custom `fetch` wrapper that detects `data:` lines
 * whose JSON payload contains a `"type"` field and injects the corresponding
 * `event: <type>` line when no `event:` line precedes it.
 *
 * @see https://github.com/openclaw/openclaw/issues/37571
 */

/**
 * Maximum number of characters to buffer before aborting the stream.
 * Prevents memory exhaustion when an upstream proxy sends data without
 * newline delimiters (CWE-400).
 */
const MAX_BUFFER_CHARS = 1_000_000;

/**
 * Sanitize an SSE event name to prevent CRLF/field injection (CWE-93).
 * Returns `null` if the value is empty after sanitization.
 */
export function sanitizeSseEventName(value: string): string | null {
  // Strip CR, LF, and other ASCII control characters
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, "");
  return stripped.length > 0 ? stripped : null;
}

/**
 * Mutable state object for tracking whether the previous line was an `event:`
 * line across chunk boundaries in a streaming SSE response.
 */
export interface SseInjectionState {
  prevWasEvent: boolean;
}

/**
 * Process a chunk of SSE text, injecting `event:` lines where missing.
 *
 * The `state` parameter carries `prevWasEvent` across calls so that an
 * `event:` line flushed at the end of one chunk correctly suppresses
 * injection for the `data:` line at the start of the next chunk.
 *
 * Only resets `prevWasEvent` on empty/blank lines (SSE event dispatch
 * boundaries) or `data:` lines, so intermediate fields like `id:` or
 * `retry:` between `event:` and `data:` do not cause false injection.
 */
export function processChunk(chunk: string, state: SseInjectionState): string {
  const lines = chunk.split(/\r?\n|\r/);
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("event:")) {
      state.prevWasEvent = true;
      result.push(line);
      continue;
    }

    if (line.startsWith("data:")) {
      if (!state.prevWasEvent) {
        const jsonStr = line.slice(5).trim();
        if (jsonStr) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed && typeof parsed.type === "string") {
              const safeType = sanitizeSseEventName(parsed.type);
              if (safeType) {
                result.push("event: " + safeType);
              }
            }
          } catch {
            // Not valid JSON — leave as-is, no event injection
          }
        }
      }
      state.prevWasEvent = false;
      result.push(line);
      continue;
    }

    // Empty line = SSE dispatch boundary — reset state.
    // Skip the trailing empty string from split (artifact of chunk ending with \n)
    // since it's not a real dispatch boundary.
    if (line === "" && i < lines.length - 1) {
      state.prevWasEvent = false;
    }
    // For other SSE fields (id:, retry:, comments) do NOT reset prevWasEvent
    // so that `event:` → `id:` → `data:` sequences are handled correctly.

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Create a custom fetch wrapper that injects SSE `event:` lines when missing.
 */
export function createSseEventInjectionFetch(): typeof globalThis.fetch {
  return async function sseEventInjectionFetch(
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await globalThis.fetch(url, init);

    // Only transform streaming responses (SSE)
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/event-stream") || !response.body) {
      return response;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    const state: SseInjectionState = { prevWasEvent: false };

    const readable = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any remaining buffer
          if (buffer.length > 0) {
            controller.enqueue(encoder.encode(processChunk(buffer, state)));
            buffer = "";
          }
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });

        // Guard against unbounded buffering when upstream sends no newlines
        if (buffer.length > MAX_BUFFER_CHARS) {
          try {
            await reader.cancel();
          } catch {
            /* best-effort */
          }
          controller.error(new Error("SSE buffer limit exceeded"));
          return;
        }

        // Process complete lines only (keep incomplete last line in buffer)
        const lastNewline = buffer.lastIndexOf("\n");
        if (lastNewline === -1) {
          return;
        }

        const toProcess = buffer.slice(0, lastNewline + 1);
        buffer = buffer.slice(lastNewline + 1);
        controller.enqueue(encoder.encode(processChunk(toProcess, state)));
      },
      cancel() {
        void reader.cancel();
      },
    });

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
