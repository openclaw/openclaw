/** Serialize a stream error safely — guards against circular non-Error values. */
export function serializeStreamError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : (() => {
        try {
          const json = JSON.stringify(error);
          if (json === undefined) return String(error);
          return json;
        } catch {
          return String(error);
        }
      })();
}