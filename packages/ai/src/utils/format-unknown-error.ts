/**
 * Formats an unknown rejection/throw value for provider stream terminal errors.
 *
 * Prefer Error.message; fall back to safe JSON, then String(). Never throw —
 * stream catch paths must still emit a terminal error event and end the stream.
 */
export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined ? String(error) : serialized;
  } catch {
    return String(error);
  }
}
