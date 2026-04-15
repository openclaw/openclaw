/**
 * Error formatting helper — self-contained re-implementation of
 * `formatErrorMessage` from `openclaw/plugin-sdk/error-runtime`.
 *
 * core/ modules use this instead of importing plugin-sdk.
 *
 * NOTE: The framework version also applies `redactSensitiveText()` for
 * token masking. In core/ we intentionally omit that — the framework's
 * log pipeline handles redaction at a higher level. If a caller needs
 * redaction, it should apply it after calling this function.
 */

/**
 * Format an error value into a human-readable message string.
 *
 * Traverses the `.cause` chain for nested Error objects to include
 * the full error context (e.g. network errors wrapped inside HTTP errors).
 */
export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    let formatted = err.message || err.name || "Error";
    // Traverse .cause chain.
    let cause: unknown = err.cause;
    const seen = new Set<unknown>([err]);
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        if (cause.message) {
          formatted += ` | ${cause.message}`;
        }
        cause = cause.cause;
      } else if (typeof cause === "string") {
        formatted += ` | ${cause}`;
        break;
      } else {
        break;
      }
    }
    return formatted;
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
