/** Serialize a stream error safely — guards against circular non-Error values. */
export function serializeStreamError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : (() => {
        try {
          return JSON.stringify(error);
        } catch {
          return String(error);
        }
      })();
}