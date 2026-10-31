import {
  iterateSseFrames,
  type GoogleStreamChunk as GoogleSseChunk,
} from "openclaw/plugin-sdk/provider-transport-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";

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
  let completed = false;
  const abortHandler = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortHandler);
  try {
    for await (const { frame, terminated } of iterateSseFrames(async () => {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      // Cancellation settles a pending read as done; never mistake that for EOF.
      signal?.throwIfAborted();
      return chunk;
    })) {
      const data = frame
        .split(/\r\n|\n|\r/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      let chunk: unknown;
      if (!terminated) {
        const trailingPayload = data || frame.trim();
        if (!trailingPayload || (!data && !trailingPayload.startsWith("{"))) {
          continue;
        }
        // Provider errors can arrive as bare JSON or data frames without their final delimiter.
        chunk = safeParseJson(trailingPayload);
        if (!isRecord(chunk) || !isRecord(chunk.error)) {
          throw new Error("Google SSE stream ended with an incomplete frame");
        }
      } else {
        if (data === "[DONE]") {
          // Compatible proxies use this boundary even when their HTTP body stays open.
          return;
        }
        if (!data) {
          continue;
        }
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new Error("Google SSE stream returned malformed JSON");
        }
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
    completed = true;
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    if (!completed) {
      await reader.cancel(signal?.reason).catch(() => undefined);
    }
    reader.releaseLock();
  }
}
