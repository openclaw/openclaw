// Shared transport classification for release readbacks. Only socket-level
// failures before a verified response qualify; callers keep content, identity,
// and integrity mismatches outside their retry loops.
const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Return whether a fetch failure is a retryable transport error.
 * @param {any} error
 * @returns {boolean}
 */
export function isTransientNetworkError(error) {
  return (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    TRANSIENT_NETWORK_CODES.has(error?.code) ||
    TRANSIENT_NETWORK_CODES.has(error?.cause?.code)
  );
}
