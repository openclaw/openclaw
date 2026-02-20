/**
 * Extracts error messages from Delta.Chat RPC errors.
 *
 * Delta.Chat RPC errors may not be standard JavaScript Error instances.
 * This helper extracts meaningful error messages regardless of the error type.
 *
 * @param err - The error object to extract a message from
 * @returns A human-readable error message string
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err && typeof err === "object") {
    // Try to extract from common RPC error structures
    const anyErr = err as Record<string, unknown>;
    // Check for common error properties
    if (typeof anyErr.message === "string") {
      return anyErr.message;
    }
    if (typeof anyErr.error === "string") {
      return anyErr.error;
    }
    if (typeof anyErr.code === "string" || typeof anyErr.code === "number") {
      return `Error code: ${anyErr.code}`;
    }
    // If it has a result property (common in JSON-RPC errors)
    if (anyErr.result && typeof anyErr.result === "string") {
      return anyErr.result;
    }
    // Fallback to JSON serialization
    try {
      return JSON.stringify(err);
    } catch {
      // JSON.stringify can fail on circular references
      return String(err);
    }
  }
  return String(err);
}
