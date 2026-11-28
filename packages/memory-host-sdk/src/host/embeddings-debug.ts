import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const debugEmbeddings = ["true", "1", "on", "yes"].includes(
  normalizeLowercaseStringOrEmpty(process.env.OPENCLAW_DEBUG_MEMORY_EMBEDDINGS),
);

/** Write embedding debug metadata when OPENCLAW_DEBUG_MEMORY_EMBEDDINGS is enabled. */
export function debugEmbeddingsLog(message: string, meta?: Record<string, unknown>): void {
  if (!debugEmbeddings) {
    return;
  }
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  console.warn(`${message}${suffix}`);
}

/** Only numeric HTTP metadata belongs in embedding shape diagnostics. */
export function embeddingResponseLogMeta(response: Response) {
  const bytes = Number(response.headers.get("content-length") ?? Number.NaN);
  return {
    status: response.status,
    responseBytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined,
  };
}

/** Enrich owned response errors without changing the text used by retry policy. */
export function addEmbeddingErrorContext(error: unknown, prefix: string, context: string): unknown {
  if (
    !(error instanceof Error) ||
    !error.message.startsWith(prefix) ||
    error.message.startsWith(context)
  ) {
    return error;
  }
  return Object.assign(error, {
    embeddingErrorMessage: error.message,
    message: `${context}${error.message.slice(prefix.length)}`,
  });
}
