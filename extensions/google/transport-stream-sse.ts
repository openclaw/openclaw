import type { GoogleStreamChunk as GoogleSseChunk } from "openclaw/plugin-sdk/provider-transport-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";

const GOOGLE_SSE_EVENT_BOUNDARY_RE = /(?:\r\n|\r(?!\n)|\n){2}/u;

export function hasGoogleFirstResponseActivity(chunk: GoogleSseChunk): boolean {
  return Boolean(
    chunk.promptFeedback ||
    chunk.candidates?.some(
      (candidate) =>
        (candidate.finishReason && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED") ||
        candidate.content?.parts?.some(
          (part) => part.text || part.functionCall || part.thoughtSignature,
        ),
    ),
  );
}

export async function* parseGoogleSseChunks(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<GoogleSseChunk> {
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const abortHandler = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortHandler);
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      // Cancellation settles a pending read as done; never mistake that for EOF.
      signal?.throwIfAborted();
      if (done) {
        buffer += decoder.decode();
        const trailingData = buffer
          .split(/\r\n|\n|\r/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        const trailingPayload = trailingData || buffer.trim();
        if (!trailingPayload || (!trailingData && !trailingPayload.startsWith("{"))) {
          completed = true;
          break;
        }
        const trailingChunk = safeParseJson(trailingPayload);
        if (!isRecord(trailingChunk) || !isRecord(trailingChunk.error)) {
          throw new Error("Google SSE stream ended with an incomplete frame");
        }
        // Provider errors can arrive as bare JSON or data frames without their final delimiter.
        buffer = `data: ${JSON.stringify(trailingChunk)}\n\n`;
      } else {
        buffer += decoder.decode(value, { stream: true });
      }
      let boundary = GOOGLE_SSE_EVENT_BOUNDARY_RE.exec(buffer);
      while (boundary) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        boundary = GOOGLE_SSE_EVENT_BOUNDARY_RE.exec(buffer);
        const data = rawEvent
          .split(/\r\n|\n|\r/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data === "[DONE]") {
          // Compatible proxies use this boundary even when their HTTP body stays open.
          return;
        }
        if (!data) {
          continue;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new Error("Google SSE stream returned malformed JSON");
        }
        if (isRecord(chunk) && isRecord(chunk.error)) {
          const providerError = chunk.error;
          const code = normalizeOptionalString(providerError.status) ?? "GOOGLE_STREAM_ERROR";
          const status = typeof providerError.code === "number" ? providerError.code : undefined;
          throw Object.assign(
            new Error(normalizeOptionalString(providerError.message) ?? "Google stream failed", {
              cause: { status, code },
            }),
            {
              code,
              status,
              type: "google_stream_failed",
            },
          );
        }
        // SAFETY: Successful frames follow Google's GenerateContentResponse contract; error envelopes are handled above.
        yield chunk as GoogleSseChunk;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    if (!completed) {
      await reader.cancel(signal?.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}
