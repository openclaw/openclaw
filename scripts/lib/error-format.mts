export class CliArgumentError extends Error {
  override name = "CliArgumentError";
}

/** Return a readable message for Error and non-Error thrown values. */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  return String(error);
}

/** Preserve the diagnostic chain for CLI failures whose owner attached nested causes. */
export function formatErrorMessageWithCauses(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current) && messages.length < 8) {
    seen.add(current);
    messages.push(formatErrorMessage(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join("\nCaused by: ");
}

/** Read Error messages unchanged and stringify every other value. */
export function coerceErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Preserve Error values and stringify every other value without workspace dependencies. */
export function toStringifiedError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Preserve structured non-Error failures without requiring built workspace packages. */
export function toErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
