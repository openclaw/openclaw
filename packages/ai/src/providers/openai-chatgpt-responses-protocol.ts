import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";

// Bound retained frame bytes before allocation; completed frames release the budget.
const OPENAI_CHATGPT_RESPONSES_SSE_FRAME_MAX_BYTES = 16 * 1024 * 1024;

export class CodexProtocolError extends Error {
  readonly payload?: unknown;

  constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
    super(message);
    this.name = "CodexProtocolError";
    this.payload = options?.payload;
    this.cause = options?.cause;
  }
}

export async function* parseOpenAIChatGptResponsesSse(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(1024);
  let size = 0;
  let lineEmpty = true;
  let skipLf = false;
  let cancelReason: unknown;

  try {
    while (true) {
      const { done, value } = await reader.read();
      // EOF also dispatches a final frame without a blank-line delimiter.
      for (let index = 0; index < (value?.length ?? 0) + (done ? 1 : 0); index++) {
        const byte = value?.[index];
        if (byte !== undefined) {
          const crlf = skipLf && byte === 10;
          skipLf = byte === 13;
          const lineEnding = byte === 10 || byte === 13;
          const boundary = !crlf && lineEnding && lineEmpty;
          lineEmpty = lineEnding;
          if (crlf && size === 0) {
            continue;
          }
          if (size >= OPENAI_CHATGPT_RESPONSES_SSE_FRAME_MAX_BYTES) {
            throw new Error(
              `OpenAI ChatGPT Responses SSE frame exceeded ${OPENAI_CHATGPT_RESPONSES_SSE_FRAME_MAX_BYTES} bytes`,
            );
          }
          if (size === buffer.length) {
            const grown = new Uint8Array(
              Math.min(buffer.length * 2, OPENAI_CHATGPT_RESPONSES_SSE_FRAME_MAX_BYTES),
            );
            grown.set(buffer);
            buffer = grown;
          }
          buffer[size++] = byte;
          if (!boundary) {
            continue;
          }
        }
        const chunk = decoder.decode(buffer.subarray(0, size), { stream: !done });
        size = 0;
        const data = chunk
          .split(/\r\n|\r|\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (!data || data === "[DONE]") {
          continue;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) {
            throw cause;
          }
          throw new CodexProtocolError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause });
        }
        // Keep suspension outside the parse catch so consumer failures stay consumer-owned.
        yield event;
      }
      if (done) {
        break;
      }
    }
  } catch (error) {
    cancelReason = error;
    throw error;
  } finally {
    // Upstream cancellation may never settle; cleanup cannot gate the primary outcome.
    void reader.cancel(cancelReason).catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {}
  }
}

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export function resolveCodexUrl(baseUrl?: string): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(baseUrl?: string): string {
  const url = new URL(resolveCodexUrl(baseUrl));
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString();
}
