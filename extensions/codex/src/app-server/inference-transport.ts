export const CODEX_INFERENCE_TRANSPORT_FAILURE =
  "Codex parent-local inference transport failed; retry on a fresh connection.";

/** Native HTTP errors wrap the private relay's exact body; other 502s are unrelated. */
export function isCodexInferenceTransportFailure(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const nativePrefix = `unexpected status 502 Bad Gateway: ${CODEX_INFERENCE_TRANSPORT_FAILURE}`;
  return (
    message === CODEX_INFERENCE_TRANSPORT_FAILURE ||
    message === nativePrefix ||
    message.startsWith(`${nativePrefix}, url: http://127.0.0.1:`)
  );
}

export function transportFailureReason(error: unknown): string {
  // Exceptions may contain request bodies or credentials. Record only a bounded cause.
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return error.name === "AbortError" ? "aborted" : "timeout";
    }
    const cause = error.cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      switch (cause.code) {
        case "ECONNRESET":
        case "ECONNREFUSED":
        case "ETIMEDOUT":
        case "ENOTFOUND":
        case "EAI_AGAIN":
        case "UND_ERR_CONNECT_TIMEOUT":
        case "UND_ERR_HEADERS_TIMEOUT":
        case "UND_ERR_SOCKET":
          return cause.code;
      }
    }
  }
  return "unclassified";
}
